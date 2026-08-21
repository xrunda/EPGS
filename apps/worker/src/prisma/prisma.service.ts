import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin Nest-lifecycle wrapper around PrismaClient, mirroring
 * apps/api/src/prisma/prisma.service.ts. apps/worker and apps/api share
 * the same Postgres database (issue #6's sync job writes MonitorRecord /
 * MonitorMatch / SyncJobLog rows; apps/api's schema/migrations, owned by
 * issue #3, are the source of truth for the shape). Deliberately does
 * NOT eagerly `$connect()` so the app can boot (and health-check) even
 * before a sync tick has run.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
