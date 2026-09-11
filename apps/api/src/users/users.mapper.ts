import { AppUser, AppUserAccess } from '@prisma/client';
import { AppUserAccessDto, AppUserDto } from '@epgs/shared-types';

/** Maps a Prisma AppUser row (+ its optional access grant) to the wire-level DTO. Never includes passwordHash. */
export function toAppUserDto(user: AppUser, access: AppUserAccess | null): AppUserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    roles: access ? access.roles : null,
    patientDetail: access?.patientDetail ?? false,
  };
}

/** Maps a Prisma AppUserAccess row to the wire-level DTO. */
export function toAppUserAccessDto(access: AppUserAccess): AppUserAccessDto {
  return {
    username: access.username,
    roles: access.roles,
    departmentScope: access.departmentScope,
    patientDetail: access.patientDetail,
    updatedAt: access.updatedAt.toISOString(),
  };
}
