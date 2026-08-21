import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { AuthTokenSigner, SessionPayload } from './auth.types';

@Injectable()
export class JwtAuthTokenService implements AuthTokenSigner {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresIn: JwtSignOptions['expiresIn'],
  ) {}

  sign(payload: SessionPayload): string {
    return this.jwt.sign(payload, { expiresIn: this.expiresIn });
  }

  verify(token: string): SessionPayload {
    const decoded = this.jwt.verify<SessionPayload>(token);
    return {
      sub: decoded.sub,
      username: decoded.username,
      passwordVersion: decoded.passwordVersion,
    };
  }
}
