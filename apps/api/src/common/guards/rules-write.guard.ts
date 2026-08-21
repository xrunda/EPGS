import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Placeholder authorization guard for write operations on monitor_rule
 * (create/update/import). Real authentication/authorization is issue
 * #13's scope, which is not implemented yet - this guard exists purely so
 * that:
 *
 *   1. Every write endpoint in the rules module already declares
 *      `@UseGuards(RulesWriteGuard)`, so wiring up real auth later is a
 *      one-file change (implement the check below) instead of touching
 *      every controller method.
 *   2. The "unauthorized access" test scenario called out in issue #4's
 *      acceptance criteria has a concrete seam to assert against
 *      (see rules.controller.spec.ts) instead of being skipped entirely.
 *
 * Current behavior: allows every request through. DOES NOT implement any
 * real authorization - do not rely on this for access control. Issue #13
 * must replace `canActivate` with a real identity/role check (and should
 * almost certainly rename/extend this class rather than leave it a no-op).
 */
@Injectable()
export class RulesWriteGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // TODO(issue #13): replace with real authentication/authorization.
    // Until then this intentionally allows all requests through so the
    // rules API is usable before the auth system exists.
    return true;
  }
}
