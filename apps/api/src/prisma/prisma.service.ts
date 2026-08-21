import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin Nest-lifecycle wrapper around PrismaClient.
 *
 * Not introduced by issue #3 (which only shipped the schema/migrations)
 * or issue #2 (worker-only PACS/RIS adapter, no Prisma dependency) - this
 * is the first place apps/api itself talks to Postgres via Prisma Client,
 * added here because issue #4's rules API is the first HTTP-facing
 * consumer of the monitor_* schema.
 *
 * Deliberately does NOT eagerly `$connect()` in onModuleInit: Prisma
 * Client connects lazily on its first actual query by default, and
 * issue #1's health/error-shape e2e suite (app.e2e-spec.ts) boots the
 * full AppModule (which now transitively includes this module) WITHOUT a
 * live Postgres - an eager $connect() here would make that suite (and
 * the base, DB-free `pnpm run test` CI job) fail. Only disconnect needs
 * an explicit hook, so real callers (the rules module) don't leak
 * connections between Nest application instances in tests.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
