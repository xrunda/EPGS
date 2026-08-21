import { AppRole } from '@prisma/client';

/**
 * Authorization context resolved for an authenticated request (issue #13).
 *
 * This is layered on top of issue #31's authentication: `request.user` is
 * the authenticated SessionUser; AccessUser is the authorization grant looked
 * up from app_user_access by username. There is no AccessUser for an account
 * without an assigned access row - role-gated endpoints then fail closed
 * (403). `departmentScope` values must exactly match monitor_record.department
 * strings; an empty array means all departments.
 */
export interface AccessUser {
  username: string;
  roles: AppRole[];
  departmentScope: string[];
  patientDetail: boolean;
}

/** Deterministic precedence for choosing the single "primary" role for audit. */
const PRIMARY_ROLE_ORDER: Record<AppRole, number> = {
  AUDITOR: 0,
  SYSTEM_ADMIN: 1,
  RULE_ADMIN: 2,
  VIEWER: 3,
};

/**
 * Returns the highest-privilege role from a user's role set (AUDITOR >
 * SYSTEM_ADMIN > RULE_ADMIN > VIEWER), used as the single `actorRole` on
 * audit rows. Returns null when the set is empty (audit then skips the row).
 */
export function pickPrimaryRole(roles: AppRole[]): AppRole | null {
  if (roles.length === 0) return null;
  return [...roles].sort((a, b) => PRIMARY_ROLE_ORDER[a] - PRIMARY_ROLE_ORDER[b])[0];
}
