import { ConflictException } from '@nestjs/common';

/** Thrown when creating an account whose username already exists. */
export class UserConflictException extends ConflictException {
  constructor(username: string) {
    super({
      code: 'USER_ALREADY_EXISTS',
      message: `账号已存在：${username}`,
    });
  }
}
