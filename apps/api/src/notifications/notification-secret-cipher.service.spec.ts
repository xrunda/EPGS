import { ConfigService } from '@nestjs/config';
import { NotificationSecretCipher } from './notification-secret-cipher.service';

function cipherWithKey(secret: string): NotificationSecretCipher {
  const configService = { get: () => secret } as unknown as ConfigService;
  return new NotificationSecretCipher(configService);
}

describe('NotificationSecretCipher', () => {
  it('encrypts then decrypts back to the original plaintext', () => {
    const cipher = cipherWithKey('a'.repeat(32));
    const plaintext = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123';

    const ciphertext = cipher.encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(cipher.decrypt(ciphertext)).toBe(plaintext);
  });

  it('never stores the plaintext webhook URL as a substring of the ciphertext', () => {
    const cipher = cipherWithKey('a'.repeat(32));
    const plaintext = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=super-secret-key';

    const ciphertext = cipher.encrypt(plaintext);

    expect(ciphertext).not.toContain('super-secret-key');
    expect(ciphertext).not.toContain(plaintext);
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const cipher = cipherWithKey('a'.repeat(32));
    const plaintext = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123';

    const first = cipher.encrypt(plaintext);
    const second = cipher.encrypt(plaintext);

    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe(plaintext);
    expect(cipher.decrypt(second)).toBe(plaintext);
  });

  it('fails to decrypt when the key is wrong, instead of returning garbage', () => {
    const encryptingCipher = cipherWithKey('correct-key-material-32-bytes!!');
    const ciphertext = encryptingCipher.encrypt('https://example.com/webhook');

    const wrongKeyCipher = cipherWithKey('a-completely-different-key-here');

    expect(() => wrongKeyCipher.decrypt(ciphertext)).toThrow();
  });

  it('rejects a malformed ciphertext payload instead of decrypting silently', () => {
    const cipher = cipherWithKey('a'.repeat(32));

    expect(() => cipher.decrypt('not-a-valid-ciphertext-payload')).toThrow(
      'Malformed notification secret ciphertext',
    );
  });

  it('throws at construction time when no secret is configured', () => {
    const configService = { get: () => undefined } as unknown as ConfigService;

    expect(() => new NotificationSecretCipher(configService)).toThrow(
      'NOTIFICATION_SECRET_KEY is not configured',
    );
  });
});
