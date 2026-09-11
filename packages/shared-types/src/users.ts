/**
 * Stable DTOs for the account/authorization management API (issue #78/#81):
 * `/api/users` (app_user CRUD) and `/api/users/:username/access`
 * (app_user_access grants). These mirror apps/api's Prisma `AppUser`/
 * `AppUserAccess` models at the wire level - see
 * apps/api/prisma/schema.prisma and docs/auth.md for the authoritative
 * field-level documentation.
 *
 * Department-scoped access (`departmentScope`) is intentionally NOT exposed
 * here: issue #78 narrowed this feature's scope to all-department access
 * only, pending a future integration with the hospital's HIS system for an
 * authoritative department list. See docs/user-admin-design.md.
 */

import { AppRoleDto } from './auth';

/** One app_user row as returned by the API. Never includes passwordHash. */
export interface AppUserDto {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
  /** Null when the account has no app_user_access row (fail-closed: all role-gated endpoints 403). */
  roles: AppRoleDto[] | null;
  patientDetail: boolean;
}

/** Query params for `GET /api/users`. */
export interface ListAppUsersQuery {
  /** Case-insensitive substring match against username or displayName. */
  search?: string;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}

/** Paginated response envelope for `GET /api/users`. */
export interface PaginatedAppUsers {
  items: AppUserDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Body for `POST /api/users`. */
export interface CreateAppUserBody {
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
}

/** Body for `PATCH /api/users/:username/status`. */
export interface UpdateAppUserStatusBody {
  isActive: boolean;
}

/** Body for `POST /api/users/:username/password`. */
export interface ResetAppUserPasswordBody {
  newPassword: string;
  confirmPassword: string;
}

/**
 * One app_user_access row as returned by the API. `departmentScope` is
 * always `[]` (all departments) - see the module doc comment above.
 */
export interface AppUserAccessDto {
  username: string;
  roles: AppRoleDto[];
  departmentScope: string[];
  patientDetail: boolean;
  updatedAt: string;
}

/**
 * Body for `PUT /api/users/:username/access`. Deliberately has no
 * `departmentScope` field - the server always writes an empty array
 * (all departments).
 */
export interface UpdateAppUserAccessBody {
  roles: AppRoleDto[];
  patientDetail: boolean;
}
