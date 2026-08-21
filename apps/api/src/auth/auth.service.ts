import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AUTH_TOKEN_SIGNER,
  AUTH_USER_STORE,
  AuthTokenSigner,
  AuthUser,
  AuthUserStore,
  PASSWORD_HASHER,
  PasswordHasher,
  SessionPayload,
  SessionUser,
} from './auth.types';

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_USER_STORE) private readonly users: AuthUserStore,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(AUTH_TOKEN_SIGNER) private readonly tokens: AuthTokenSigner,
  ) {}

  async login(username: string, password: string): Promise<{ user: SessionUser; token: string }> {
    const user = await this.users.findByUsername(username);
    const passwordMatches = user ? await this.passwords.verify(user.passwordHash, password) : false;
    if (!user || !passwordMatches) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: '账号或密码错误。',
      });
    }
    if (!user.isActive) {
      throw new ForbiddenException({ code: 'AUTH_ACCOUNT_DISABLED', message: '账号已停用。' });
    }

    return {
      user: this.toSessionUser(user),
      token: this.tokens.sign({
        sub: user.id,
        username: user.username,
        passwordVersion: user.passwordVersion,
      }),
    };
  }

  async validateSession(payload: SessionPayload): Promise<SessionUser> {
    const user = await this.users.findById(payload.sub);
    if (
      !user ||
      !user.isActive ||
      user.username !== payload.username ||
      user.passwordVersion !== payload.passwordVersion
    ) {
      throw new UnauthorizedException({
        code: 'AUTH_SESSION_INVALID',
        message: '登录状态已失效。',
      });
    }
    return this.toSessionUser(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<void> {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException({
        code: 'AUTH_PASSWORD_MISMATCH',
        message: '两次输入的新密码不一致。',
      });
    }
    const user = await this.users.findById(userId);
    if (!user || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException({
        code: 'AUTH_CURRENT_PASSWORD_INVALID',
        message: '当前密码错误。',
      });
    }
    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new BadRequestException({
        code: 'AUTH_PASSWORD_REUSED',
        message: '新密码不能与当前密码相同。',
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.users.updatePassword(user.id, passwordHash, user.passwordVersion);
  }

  private toSessionUser(user: AuthUser): SessionUser {
    return { id: user.id, username: user.username, displayName: user.displayName };
  }
}
