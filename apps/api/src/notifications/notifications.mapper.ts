import { NotificationChannel, NotificationTemplate } from '@prisma/client';
import { NotificationChannelDto, NotificationTemplateDto } from '@epgs/shared-types';

/**
 * Maps Prisma notification rows to wire-level DTOs (issue #54).
 *
 * SECURITY CONTRACT (design §5, shared-types/notification.ts): the plaintext
 * webhook URL never leaves the service. Reads expose only `webhookUrlMasked`
 * - a deliberately DIFFERENT field name from the writable `webhookUrl`, so a
 * masked read value can never be echoed back into a PUT as if it were the
 * real URL.
 */

/**
 * Masks a WeCom webhook URL for display: keeps scheme/host/path and any
 * non-secret query params, but replaces the `key` query-param VALUE with its
 * first 4 chars + `****` (e.g. `...?key=8d24****`). A URL that cannot be
 * parsed falls back to a length-based generic mask.
 */
export function maskWebhookUrl(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl);
    const key = url.searchParams.get('key');
    if (key) {
      url.searchParams.set('key', key.length > 4 ? `${key.slice(0, 4)}****` : '****');
    }
    return url.toString();
  } catch {
    // Not a parseable URL - we can't identify the secret part, so mask
    // aggressively rather than risk leaking it.
    return webhookUrl.length > 8 ? `${webhookUrl.slice(0, 8)}****` : '****';
  }
}

/**
 * Maps a Prisma NotificationChannel row to the wire DTO. `decrypt` is the
 * injected NotificationSecretCipher.decrypt; a failure to decrypt (e.g.
 * corrupted ciphertext or a rotated key) yields the placeholder
 * `<unavailable>` instead of throwing, so one bad row never 500s an entire
 * list response.
 */
export function toChannelDto(
  channel: NotificationChannel,
  decrypt: (ciphertext: string) => string,
): NotificationChannelDto {
  let webhookUrlMasked = '<unavailable>';
  try {
    webhookUrlMasked = maskWebhookUrl(decrypt(channel.webhookUrlCiphertext));
  } catch {
    // Intentionally swallowed - see doc comment above.
  }
  return {
    id: channel.id,
    name: channel.name,
    webhookUrlMasked,
    isEnabled: channel.isEnabled,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
    createdBy: channel.createdBy,
    updatedBy: channel.updatedBy,
  };
}

/** Maps a Prisma NotificationTemplate row to the wire DTO. */
export function toTemplateDto(template: NotificationTemplate): NotificationTemplateDto {
  return {
    id: template.id,
    name: template.name,
    msgType: template.msgType,
    titleTemplate: template.titleTemplate,
    contentTemplate: template.contentTemplate,
    coverImageUrl: template.coverImageUrl,
    linkUrl: template.linkUrl,
    isEnabled: template.isEnabled,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    createdBy: template.createdBy,
    updatedBy: template.updatedBy,
  };
}
