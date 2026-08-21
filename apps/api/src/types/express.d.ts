// Augments Express's Request type with the correlationId field attached
// by CorrelationIdMiddleware and the accessUser field attached by
// RolesGuard (issue #13). Declared against 'express' (not
// 'express-serve-static-core') because that's the module apps/api
// actually resolves @types for in this workspace's node_modules layout.
import 'express';
import type { AccessUser } from '../access/access-user';

declare module 'express' {
  interface Request {
    correlationId?: string;
    /** Authorization grant resolved by RolesGuard (issue #13) - see @CurrentUser(). */
    accessUser?: AccessUser | null;
  }
}
