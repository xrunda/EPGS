import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JwtAuthTokenService } from './auth-token.service';
import { Argon2PasswordHasher } from './password-hasher.service';
import { PrismaAuthUserStore } from './prisma-auth-user.store';
import {
  AUTH_COOKIE_OPTIONS,
  AUTH_TOKEN_SIGNER,
  AUTH_USER_STORE,
  PASSWORD_HASHER,
} from './auth.types';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    PrismaAuthUserStore,
    Argon2PasswordHasher,
    {
      provide: JwtService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new JwtService({ secret: config.getOrThrow<string>('jwtSecret') }),
    },
    {
      provide: AUTH_USER_STORE,
      useExisting: PrismaAuthUserStore,
    },
    {
      provide: PASSWORD_HASHER,
      useExisting: Argon2PasswordHasher,
    },
    {
      provide: AUTH_TOKEN_SIGNER,
      inject: [JwtService, ConfigService],
      useFactory: (jwt: JwtService, config: ConfigService) =>
        new JwtAuthTokenService(jwt, config.getOrThrow<number>('jwtExpiresSeconds')),
    },
    {
      provide: AUTH_COOKIE_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        httpOnly: true as const,
        sameSite: 'lax' as const,
        secure: config.get<string>('nodeEnv') === 'production',
        path: '/' as const,
        maxAge: config.getOrThrow<number>('jwtExpiresSeconds') * 1000,
      }),
    },
    {
      provide: APP_GUARD,
      useExisting: AuthGuard,
    },
  ],
  exports: [AuthService, AUTH_USER_STORE, PASSWORD_HASHER],
})
export class AuthModule {}
