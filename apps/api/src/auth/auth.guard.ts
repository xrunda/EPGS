import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AUTH_TOKEN_SIGNER, AuthTokenSigner, SessionPayload } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

export const AUTH_COOKIE_NAME = 'epgs_session';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    }
  }
  return undefined;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_TOKEN_SIGNER) private readonly tokens: Pick<AuthTokenSigner, 'verify'>,
    @Inject(AuthService) private readonly auth: Pick<AuthService, 'validateSession'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: { cookie?: string };
      user?: unknown;
    }>();
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
    if (!token) throw this.unauthorized();

    try {
      const payload = this.tokens.verify(token) as SessionPayload;
      request.user = await this.auth.validateSession(payload);
      return true;
    } catch {
      throw this.unauthorized();
    }
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '请先登录。' });
  }
}
