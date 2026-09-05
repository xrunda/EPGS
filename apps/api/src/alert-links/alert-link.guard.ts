import {
  CanActivate,
  ExecutionContext,
  GoneException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ALERT_LINK_TOKEN_RE, hashAlertLinkToken } from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';
import { AlertLinkRequest } from './alert-link.types';

/**
 * The limited credential for the WeCom alert H5 page (issue #72).
 *
 * This is deliberately NOT a session: the opaque link token IS the credential
 * (`Authorization: Bearer <token>`), looked up by its SHA-256 hash on every
 * request. It never sets or reads `epgs_session`, so a link can never be
 * confused with - or escalate into - a workbench login. The controller is
 * `@Public()` (so AuthGuard/RolesGuard pass) and applies this guard instead;
 * everything downstream reads `request.alertLink.recordIds` as the hard
 * authorization boundary (docs/auth.md "预警链接受限凭证").
 *
 * Failure semantics mirror the page copy:
 *   401 ALERT_LINK_INVALID  - no/ malformed/ unknown token (never reveals which)
 *   410 ALERT_LINK_EXPIRED  - known token past expiresAt (24h by default)
 */
@Injectable()
export class AlertLinkGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AlertLinkRequest>();
    const token = readBearerToken(request.headers.authorization);
    if (!token || !ALERT_LINK_TOKEN_RE.test(token)) throw invalid();

    const row = await this.prisma.alertLink.findUnique({
      where: { tokenHash: hashAlertLinkToken(token) },
      select: {
        id: true,
        level: true,
        windowDate: true,
        recordIds: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    if (!row) throw invalid();
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({
        code: 'ALERT_LINK_EXPIRED',
        message: '链接已失效（超过有效期），请登录工作台查看。',
      });
    }

    request.alertLink = row;
    return true;
  }
}

/** Extracts the value of an `Authorization: Bearer <value>` header (scheme case-insensitive). */
export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const separator = header.indexOf(' ');
  if (separator < 0) return undefined;
  if (header.slice(0, separator).toLowerCase() !== 'bearer') return undefined;
  const value = header.slice(separator + 1).trim();
  return value === '' ? undefined : value;
}

function invalid(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'ALERT_LINK_INVALID',
    message: '链接无效，请从企业微信消息重新打开。',
  });
}
