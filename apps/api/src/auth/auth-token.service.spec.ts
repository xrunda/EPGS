import { JwtService } from '@nestjs/jwt';
import { JwtAuthTokenService } from './auth-token.service';

describe('JwtAuthTokenService', () => {
  it('signs and verifies only the minimal session claims', () => {
    const service = new JwtAuthTokenService(
      new JwtService({ secret: 'test-secret-at-least-32-characters' }),
      '8h',
    );
    const payload = { sub: 'user-1', username: 'doctor', passwordVersion: 3 };
    const token = service.sign(payload);

    expect(service.verify(token)).toEqual(payload);
    expect(token).not.toContain('doctor');
  });
});
