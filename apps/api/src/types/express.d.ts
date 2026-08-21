// Augments Express's Request type with the correlationId field attached
// by CorrelationIdMiddleware. Declared against 'express' (not
// 'express-serve-static-core') because that's the module apps/api
// actually resolves @types for in this workspace's node_modules layout.
import 'express';

declare module 'express' {
  interface Request {
    correlationId?: string;
  }
}
