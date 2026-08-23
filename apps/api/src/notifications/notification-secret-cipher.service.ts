import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit nonce, the GCM-recommended size.

/**
 * Encrypts/decrypts NotificationChannel.webhookUrlCiphertext - the first
 * REVERSIBLE secret this schema stores (see schema.prisma's
 * NotificationChannel doc comment for why this differs from
 * app_user.passwordHash's one-way Argon2id hash).
 *
 * Ciphertext format: "<base64 iv>:<base64 authTag>:<base64 ciphertext>".
 * A fresh random IV is generated on every encrypt call (never reused with
 * the same key), so encrypting the same plaintext twice yields different
 * ciphertext - this is intentional and expected, not a bug: it prevents an
 * attacker with read access to the table from noticing that two channels
 * share the same webhook URL by comparing ciphertext bytes.
 *
 * The key comes from NOTIFICATION_SECRET_KEY (see env.validation.ts),
 * never persisted to the database, same operational tier as JWT_SECRET.
 */
@Injectable()
export class NotificationSecretCipher {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const secret = configService.get<string>('notificationSecretKey');
    if (!secret) {
      // Should be unreachable in practice - env.validation.ts requires this
      // var at startup - but fail loudly rather than encrypting with an
      // empty/undefined key if the config wiring is ever bypassed (e.g. in
      // a unit test that constructs ConfigService directly).
      throw new Error('NOTIFICATION_SECRET_KEY is not configured');
    }
    // Derive a fixed 32-byte key from the configured secret via SHA-256
    // rather than requiring the operator to produce exactly 32 raw bytes -
    // env.validation.ts only enforces a minimum string length.
    this.key = createHashKey(secret);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('Malformed notification secret ciphertext');
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

function createHashKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}
