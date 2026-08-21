import { Controller, Get } from '@nestjs/common';
import { HealthStatus } from '@epgs/shared-types';
import { readFileSync } from 'fs';
import { join } from 'path';

function resolveVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = resolveVersion();

/**
 * The worker is not meant to be publicly exposed, but it must be
 * independently startable/testable, so it gets a minimal /health on its
 * own port (distinct from apps/api's port) rather than being folded
 * into the API process.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptime: process.uptime(),
    };
  }
}
