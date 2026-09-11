import { NotFoundException } from '@nestjs/common';

/** Thrown when a username does not resolve to any app_user row. */
export class UserNotFoundException extends NotFoundException {
  constructor(username: string) {
    super({
      code: 'USER_NOT_FOUND',
      message: `账号不存在：${username}`,
    });
  }
}
