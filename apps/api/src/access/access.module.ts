import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessResolver } from './access-resolver';
import { RolesGuard } from './roles.guard';

/**
 * Issue #13 authorization: resolves app_user_access grants and enforces
 * @RequireRoles globally. Must be imported AFTER AuthModule (issue #31) so
 * the global AuthGuard runs first and populates request.user - APP_GUARDs
 * are applied in module import order.
 */
@Module({
  providers: [AccessResolver, RolesGuard, { provide: APP_GUARD, useExisting: RolesGuard }],
  exports: [AccessResolver],
})
export class AccessModule {}
