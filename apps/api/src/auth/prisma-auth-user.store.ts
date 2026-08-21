import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, AuthUserStore } from './auth.types';

@Injectable()
export class PrismaAuthUserStore implements AuthUserStore {
  constructor(private readonly prisma: PrismaService) {}

  findByUsername(username: string): Promise<AuthUser | null> {
    return this.prisma.appUser.findUnique({ where: { username: username.trim().toLowerCase() } });
  }

  findById(id: string): Promise<AuthUser | null> {
    return this.prisma.appUser.findUnique({ where: { id } });
  }

  async updatePassword(
    id: string,
    passwordHash: string,
    expectedVersion: number,
  ): Promise<AuthUser> {
    const result = await this.prisma.appUser.updateMany({
      where: { id, passwordVersion: expectedVersion },
      data: { passwordHash, passwordVersion: { increment: 1 } },
    });
    if (result.count !== 1) {
      throw new ConflictException({
        code: 'AUTH_PASSWORD_VERSION_CONFLICT',
        message: '密码已被其他操作修改，请重新登录后再试。',
      });
    }
    const updated = await this.findById(id);
    if (!updated) {
      throw new ConflictException({ code: 'AUTH_USER_NOT_FOUND', message: '账号不存在。' });
    }
    return updated;
  }

  create(username: string, displayName: string, passwordHash: string): Promise<AuthUser> {
    return this.prisma.appUser.create({
      data: {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        passwordHash,
      },
    });
  }
}
