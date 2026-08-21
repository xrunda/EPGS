import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChangePasswordDto, LoginDto } from './auth.dto';

describe('auth DTO validation', () => {
  it('rejects empty login fields', async () => {
    const errors = await validate(plainToInstance(LoginDto, { username: '', password: '' }));
    expect(errors).toHaveLength(2);
  });

  it('requires a new password of at least eight characters and matching confirmation', async () => {
    const short = await validate(
      plainToInstance(ChangePasswordDto, {
        currentPassword: 'current-password',
        newPassword: 'short',
        confirmPassword: 'different',
      }),
    );
    expect(short.map((error) => error.property)).toContain('newPassword');
    expect(short.map((error) => error.property)).toContain('confirmPassword');
  });
});
