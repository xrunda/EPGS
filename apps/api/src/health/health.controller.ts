import { Controller, Get } from '@nestjs/common';
import { HealthStatus } from '@epgs/shared-types';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Resolves the app version from package.json at runtime without a
 * TypeScript `require`/import (which would drag package.json into the
 * compiled output's rootDir resolution). Falls back to "0.0.0" if
 * unreadable so /health never throws because of this.
 */
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
