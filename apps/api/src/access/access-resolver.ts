import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessUser } from './access-user';

/**
 * Resolves an authenticated user's authorization grant from app_user_access
 * (issue #13). Identity itself is issue #31's job (AuthGuard + request.user);
 * this is the authorization lookup that layers roles/data-scope/masking on top.
 *
 * Deliberately uncached: access assignments are read straight from Postgres on
 * every request, so CLI updates (`auth:assign-access`) take effect immediately
 * without any session/token re-issue. A single PK lookup per authenticated
 * request is acceptable for the hospital intranet scale.
 */
@Injectable()
export class AccessResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns null when the account has no app_user_access row (fail-closed). */
  async resolveByUsername(username: string): Promise<AccessUser | null> {
    const row = await this.prisma.appUserAccess.findUnique({ where: { username } });
    if (!row) return null;
    return {
      username: row.username,
      roles: row.roles,
      departmentScope: row.departmentScope,
      patientDetail: row.patientDetail,
    };
  }
}
