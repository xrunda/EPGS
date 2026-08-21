import { Argon2PasswordHasher } from './password-hasher.service';

describe('Argon2PasswordHasher', () => {
  it('stores an irreversible hash and verifies only the original password', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('example-password');

    expect(hash).not.toBe('example-password');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(hasher.verify(hash, 'example-password')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('treats malformed hashes as a failed comparison without leaking an error', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.verify('not-a-hash', 'example-password')).resolves.toBe(false);
  });
});
