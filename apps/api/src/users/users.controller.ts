import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { AppUserAccessDto, AppUserDto, PaginatedAppUsers } from '@epgs/shared-types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users.query.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAccessDto } from './dto/update-access.dto';
import { UpdateUserStatusDto } from './dto/update-status.dto';
import { UsersService } from './users.service';

/**
 * Issue #78/#81: account and access-grant management, replacing the
 * CLI-only auth-cli.ts/access-cli.ts workflow for day-to-day operation (the
 * CLI remains as a break-glass fallback - see docs/auth.md). Every route
 * requires AppRole.USER_ADMIN - this role is deliberately separate from
 * SYSTEM_ADMIN and has no access to monitor data or rules (see docs/auth.md
 * role table). Every write records an audit row with the
 * USER_CREATE/USER_ROLE_CHANGE/USER_DISABLE/USER_ENABLE/USER_DELETE/
 * USER_PASSWORD_RESET actions added in issue #79 - `meta` never contains a
 * password or password hash.
 */
@ApiTags('users')
@Controller('api/users')
@RequireRoles(AppRole.USER_ADMIN)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List accounts with their current access grant, paginated (USER_ADMIN only).' })
  list(@Query() query: ListUsersQueryDto): Promise<PaginatedAppUsers> {
    return this.usersService.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new account (USER_ADMIN only). No access grant yet - assign one via PUT .../access.' })
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<AppUserDto> {
    const result = await this.usersService.create(dto);
    await this.audit.record({
      action: AuditAction.USER_CREATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'app_user',
      meta: { username: result.username },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Patch(':username/status')
  @ApiOperation({ summary: 'Enable or disable an account (USER_ADMIN only). Does not delete data.' })
  async updateStatus(
    @Param('username') username: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<AppUserDto> {
    const result = await this.usersService.updateStatus(username, dto.isActive);
    await this.audit.record({
      action: dto.isActive ? AuditAction.USER_ENABLE : AuditAction.USER_DISABLE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'app_user',
      meta: { username: result.username, isActive: result.isActive },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Post(':username/password')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Reset an account password (USER_ADMIN only). Invalidates all existing sessions for that account.',
  })
  async resetPassword(
    @Param('username') username: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<void> {
    await this.usersService.resetPassword(username, dto.newPassword);
    await this.audit.record({
      action: AuditAction.USER_PASSWORD_RESET,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'app_user',
      meta: { username },
      ip: request.ip,
      correlationId: request.correlationId,
    });
  }

  @Delete(':username')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an account and its access grant together (USER_ADMIN only). Not reversible.',
  })
  async delete(
    @Param('username') username: string,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<void> {
    await this.usersService.delete(username);
    await this.audit.record({
      action: AuditAction.USER_DELETE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'app_user',
      meta: { username },
      ip: request.ip,
      correlationId: request.correlationId,
    });
  }

  @Get(':username/access')
  @ApiOperation({ summary: 'Get the current access grant for an account (USER_ADMIN only).' })
  getAccess(@Param('username') username: string): Promise<AppUserAccessDto> {
    return this.usersService.getAccess(username);
  }

  @Put(':username/access')
  @ApiOperation({
    summary:
      'Full replacement of roles/patientDetail for an account (USER_ADMIN only). Not a merge - mirrors auth:assign-access. departmentScope is always all-departments (issue #78 scope narrowing).',
  })
  async updateAccess(
    @Param('username') username: string,
    @Body() dto: UpdateAccessDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<AppUserAccessDto> {
    const result = await this.usersService.updateAccess(username, dto);
    await this.audit.record({
      action: AuditAction.USER_ROLE_CHANGE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'app_user_access',
      meta: { username, roles: result.roles, patientDetail: result.patientDetail },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
