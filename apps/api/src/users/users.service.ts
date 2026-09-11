import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AppRole, Prisma } from '@prisma/client';
import { AppUserAccessDto, AppUserDto, PaginatedAppUsers } from '@epgs/shared-types';
import { PASSWORD_HASHER, PasswordHasher } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { UpdateAccessDto } from './dto/update-access.dto';
import { UserConflictException } from './errors/user-conflict.exception';
import { UserNotFoundException } from './errors/user-not-found.exception';
import { toAppUserAccessDto, toAppUserDto } from './users.mapper';

/** Sentinel for AppUserAccessDto.updatedAt when no app_user_access row exists yet - see getAccess(). */
const NO_ACCESS_GRANT_UPDATED_AT = new Date(0);

/**
 * Account and access-grant management for the user-admin feature (issue
 * #78/#81), gated by AppRole.USER_ADMIN at the controller. Reuses the same
 * Argon2id hasher as the login/auth-cli path (issue #31) so passwords set
 * here verify identically at login.
 *
 * departmentScope has no field on this API's DTOs (issue #78 scope
 * narrowing - see docs/user-admin-design.md): new grants get [] (all
 * departments), and updateAccess() preserves whatever departmentScope an
 * account already has rather than forcing it to [] on every write - see
 * that method's doc comment for why (a CLI-set non-empty scope must not be
 * silently wiped by a Web-side role/patientDetail edit).
 *
 * app_user_access is keyed by username (not an FK - see schema.prisma), so
 * account and access-grant rows are managed independently but deleted
 * together (delete()) to avoid leaving an orphaned grant a future
 * same-named account would silently inherit.
 *
 * assertNotLastUserAdmin() guards updateStatus(disable)/delete/updateAccess
 * against leaving zero USER_ADMIN accounts in the system - without it a
 * lockout has no in-band recovery path (the CLI break-glass fallback needs
 * server access, not a Web session).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
  ) {}

  async list(query: ListUsersQueryDto): Promise<PaginatedAppUsers> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.AppUserWhereInput = {
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search, mode: 'insensitive' } },
              { displayName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    // Plain Promise.all (not $transaction, matching AuditService.list's
    // pattern) - the access-grant lookup depends on `users` so it cannot be
    // in the same transaction anyway, and this listing has no consistency
    // requirement stronger than "good enough for an admin table view".
    const [users, total] = await Promise.all([
      this.prisma.appUser.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.appUser.count({ where }),
    ]);

    const accessRows = await this.prisma.appUserAccess.findMany({
      where: { username: { in: users.map((u) => u.username) } },
    });
    const accessByUsername = new Map(accessRows.map((row) => [row.username, row]));

    return {
      items: users.map((user) => toAppUserDto(user, accessByUsername.get(user.username) ?? null)),
      total,
      page,
      pageSize,
    };
  }

  async create(dto: CreateUserDto): Promise<AppUserDto> {
    const username = dto.username.trim().toLowerCase();
    const existing = await this.prisma.appUser.findUnique({ where: { username } });
    if (existing) throw new UserConflictException(username);

    const passwordHash = await this.passwords.hash(dto.password);
    const created = await this.prisma.appUser.create({
      data: { username, displayName: dto.displayName.trim(), passwordHash },
    });
    return toAppUserDto(created, null);
  }

  async updateStatus(rawUsername: string, isActive: boolean): Promise<AppUserDto> {
    const user = await this.findUserOrThrow(rawUsername);
    const [updated, access] = await this.prisma.$transaction(async (tx) => {
      // Guard check + write share one transaction (see assertNotLastUserAdmin's
      // doc comment) so two concurrent disables of the last two USER_ADMIN
      // accounts cannot both pass the count check before either commits.
      if (!isActive) await this.assertNotLastUserAdmin(tx, user.username);
      const updatedUser = await tx.appUser.update({ where: { id: user.id }, data: { isActive } });
      const accessRow = await tx.appUserAccess.findUnique({ where: { username: user.username } });
      return [updatedUser, accessRow] as const;
    });
    return toAppUserDto(updated, access);
  }

  async resetPassword(rawUsername: string, newPassword: string): Promise<void> {
    const user = await this.findUserOrThrow(rawUsername);
    const passwordHash = await this.passwords.hash(newPassword);
    // Mirrors PrismaAuthUserStore.updatePassword (issue #31): increments
    // passwordVersion so every existing JWT (which embeds the prior version)
    // is invalidated immediately, without a session table.
    await this.prisma.appUser.update({
      where: { id: user.id },
      data: { passwordHash, passwordVersion: { increment: 1 } },
    });
  }

  /** Deletes the account and its access grant together (see class doc). */
  async delete(rawUsername: string): Promise<void> {
    const user = await this.findUserOrThrow(rawUsername);
    await this.prisma.$transaction(async (tx) => {
      // Guard check + both deletes share one transaction - see updateStatus's comment.
      await this.assertNotLastUserAdmin(tx, user.username);
      await tx.appUserAccess.deleteMany({ where: { username: user.username } });
      await tx.appUser.delete({ where: { id: user.id } });
    });
  }

  async getAccess(rawUsername: string): Promise<AppUserAccessDto> {
    const user = await this.findUserOrThrow(rawUsername);
    const access = await this.prisma.appUserAccess.findUnique({ where: { username: user.username } });
    return toAppUserAccessDto(
      access ?? {
        username: user.username,
        roles: [] as AppRole[],
        departmentScope: [],
        patientDetail: false,
        // Epoch sentinel for "no app_user_access row exists yet" - there is
        // no real updatedAt to report. Surfaced as-is in the API response
        // (see docs/user-admin-api.md); a consumer doing date math on this
        // field should treat epoch as "never granted", not a real edit time.
        updatedAt: NO_ACCESS_GRANT_UPDATED_AT,
      },
    );
  }

  /**
   * Full replacement of roles/patientDetail, mirroring auth:assign-access
   * semantics - not a merge. departmentScope is NOT forced to [] here: this
   * endpoint has no UI/DTO field for it (issue #78 scope narrowing - see
   * docs/user-admin-design.md), so a caller that only means to touch
   * roles/patientDetail must not silently wipe a non-empty departmentScope a
   * CLI operator set earlier via auth:assign-access --departments. New
   * grants (and existing all-department ones) still end up with [] - only a
   * pre-existing NON-EMPTY scope is preserved.
   */
  async updateAccess(rawUsername: string, dto: UpdateAccessDto): Promise<AppUserAccessDto> {
    const user = await this.findUserOrThrow(rawUsername);
    const username = user.username;
    const saved = await this.prisma.$transaction(async (tx) => {
      // Guard check, the departmentScope-preserving read, and the upsert all
      // share one transaction: without this, a concurrent request could
      // either (a) also pass the last-USER_ADMIN count check before either
      // commits, or (b) race a CLI auth:assign-access --departments write
      // between this read and the upsert, silently clobbering it - see
      // updateAccess's class-level doc comment.
      if (!dto.roles.includes(AppRole.USER_ADMIN)) {
        await this.assertNotLastUserAdmin(tx, username);
      }
      const existing = await tx.appUserAccess.findUnique({ where: { username } });
      return tx.appUserAccess.upsert({
        where: { username },
        create: {
          username,
          roles: dto.roles,
          departmentScope: [],
          patientDetail: dto.patientDetail,
        },
        update: {
          roles: dto.roles,
          departmentScope: existing?.departmentScope ?? [],
          patientDetail: dto.patientDetail,
        },
      });
    });
    return toAppUserAccessDto(saved);
  }

  /** Normalizes the same way create() does (trim + lowercase) so a path param typed with different casing than storage still resolves. */
  private async findUserOrThrow(rawUsername: string) {
    const username = rawUsername.trim().toLowerCase();
    const user = await this.prisma.appUser.findUnique({ where: { username } });
    if (!user) throw new UserNotFoundException(rawUsername);
    return user;
  }

  /**
   * Refuses an operation that would leave zero USER_ADMIN accounts in the
   * system (self-demotion, self-disable, self-delete, or doing any of that
   * to the last other USER_ADMIN). Without this, a lockout has no in-band
   * recovery: the CLI is documented as the break-glass fallback, but it
   * requires server/bastion access, not a Web session - see docs/auth.md.
   *
   * Takes a Prisma transaction client (not `this.prisma`) and MUST be called
   * from inside the same `$transaction` as the write it's guarding -
   * otherwise two concurrent requests targeting the last two USER_ADMIN
   * accounts could both pass this count check before either commits,
   * defeating the guard (TOCTOU).
   */
  private async assertNotLastUserAdmin(
    tx: Prisma.TransactionClient,
    targetUsername: string,
  ): Promise<void> {
    const target = await tx.appUserAccess.findUnique({ where: { username: targetUsername } });
    if (!target || !target.roles.includes(AppRole.USER_ADMIN)) return;

    const remaining = await tx.appUserAccess.count({
      where: { username: { not: targetUsername }, roles: { has: AppRole.USER_ADMIN } },
    });
    if (remaining === 0) {
      throw new ConflictException({
        code: 'LAST_USER_ADMIN_PROTECTED',
        message: `无法执行此操作：${targetUsername} 是系统中最后一个 USER_ADMIN 账号，移除会导致无人能管理账号。请先给另一个账号分配 USER_ADMIN 角色。`,
      });
    }
  }
}
