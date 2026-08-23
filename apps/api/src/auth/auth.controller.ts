import type { AccessUser } from '../access/access-user';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AUTH_COOKIE_NAME } from './auth.guard';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import { Public } from './public.decorator';
import { AUTH_COOKIE_OPTIONS, AuthCookieOptions, SessionUser } from './auth.types';

type AuthenticatedRequest = Request & {
  user: SessionUser;
  /** Set by the global RolesGuard for every non-public route (including /me). */
  accessUser?: AccessUser | null;
};

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: Pick<AuthService, 'login' | 'changePassword'>,
    @Inject(AUTH_COOKIE_OPTIONS) private readonly cookieOptions: AuthCookieOptions,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '使用本地账号登录并设置 HttpOnly 会话 Cookie。' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto.username, dto.password);
    response.cookie(AUTH_COOKIE_NAME, result.token, this.cookieOptions);
    return { user: result.user };
  }

  @Get('me')
  @ApiOperation({ summary: '返回当前登录用户的最小信息与角色。' })
  me(@Req() request: AuthenticatedRequest): {
    user: SessionUser & { roles: AccessUser['roles'] };
  } {
    // roles 来自 RolesGuard 已解析的 app_user_access（每次请求实时查询），
    // 无 access 行的账号返回空数组。login 响应刻意保持最小形状（不含 roles）。
    return { user: { ...request.user, roles: request.accessUser?.roles ?? [] } };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: '退出登录并清除会话 Cookie。' })
  logout(@Res({ passthrough: true }) response: Response): { success: true } {
    this.clearCookie(response);
    return { success: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: '修改当前用户密码，使旧会话立即失效。' })
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    await this.auth.changePassword(
      request.user.id,
      dto.currentPassword,
      dto.newPassword,
      dto.confirmPassword,
    );
    this.clearCookie(response);
    return { success: true };
  }

  private clearCookie(response: Response): void {
    response.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: this.cookieOptions.sameSite,
      secure: this.cookieOptions.secure,
      path: this.cookieOptions.path,
    });
  }
}
