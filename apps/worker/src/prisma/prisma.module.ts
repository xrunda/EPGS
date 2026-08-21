import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global module so every feature module (sync now, others later) can
 * inject PrismaService without re-declaring it as a provider each time.
 * Mirrors apps/api/src/prisma/prisma.module.ts.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
