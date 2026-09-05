import { ExecutionContext, GoneException, UnauthorizedException } from '@nestjs/common';
import { hashAlertLinkToken } from '@epgs/notification-push';
import { AlertLinkGuard, readBearerToken } from './alert-link.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AlertLinkRequest } from './alert-link.types';

const TOKEN = 'k3JxPq9vL2mN8bR5tW7yA1cE4gH6jK0oS2uV4xZ6bD8';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    level: 'RED',
    windowDate: '2026-09-05',
    recordIds: ['r1', 'r2'],
    createdAt: new Date('2026-09-05T01:00:00Z'),
    expiresAt: FUTURE,
    ...overrides,
  };
}

function makeContext(authorization?: string): {
  context: ExecutionContext;
  request: AlertLinkRequest;
} {
  const request = { headers: { authorization } } as unknown as AlertLinkRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, request };
}

function build(row: unknown) {
  const prisma = { alertLink: { findUnique: jest.fn(async (_args: unknown) => row) } };
  return { guard: new AlertLinkGuard(prisma as unknown as PrismaService), prisma };
}

describe('readBearerToken', () => {
  it('extracts the value after a case-insensitive Bearer scheme', () => {
    expect(readBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(readBearerToken(`BEARER   ${TOKEN}  `)).toBe(TOKEN);
  });

  it('returns undefined for a missing header, another scheme, or an empty value', () => {
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken('')).toBeUndefined();
    expect(readBearerToken(`Basic ${TOKEN}`)).toBeUndefined();
    expect(readBearerToken('Bearer')).toBeUndefined();
    expect(readBearerToken('Bearer  ')).toBeUndefined();
  });
});

describe('AlertLinkGuard', () => {
  it('rejects a missing Authorization header with 401 ALERT_LINK_INVALID without touching the DB', async () => {
    const { guard, prisma } = build(makeRow());
    const { context } = makeContext(undefined);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: UnauthorizedException,
      response: { code: 'ALERT_LINK_INVALID' },
    });
    expect(prisma.alertLink.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed token (wrong charset / too short) before the DB lookup', async () => {
    const { guard, prisma } = build(makeRow());

    await expect(guard.canActivate(makeContext('Bearer short').context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(makeContext('Bearer has spaces and+plus/slash=1234567890').context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.alertLink.findUnique).not.toHaveBeenCalled();
  });

  it('looks the token up by its SHA-256 hash only and rejects an unknown token with the same 401', async () => {
    const { guard, prisma } = build(null);
    const { context } = makeContext(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'ALERT_LINK_INVALID' },
    });
    expect(prisma.alertLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashAlertLinkToken(TOKEN) } }),
    );
    // The raw token must never reach the query.
    expect(JSON.stringify(prisma.alertLink.findUnique.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it('rejects an expired link with 410 ALERT_LINK_EXPIRED', async () => {
    const { guard } = build(makeRow({ expiresAt: PAST }));
    const { context, request } = makeContext(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: GoneException,
      response: { code: 'ALERT_LINK_EXPIRED' },
    });
    expect(request.alertLink).toBeUndefined();
  });

  it('attaches the resolved link (snapshot ids, level, window, expiry) for a live token', async () => {
    const { guard } = build(makeRow());
    const { context, request } = makeContext(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.alertLink).toEqual({
      id: 'link-1',
      level: 'RED',
      windowDate: '2026-09-05',
      recordIds: ['r1', 'r2'],
      createdAt: new Date('2026-09-05T01:00:00Z'),
      expiresAt: FUTURE,
    });
  });
});
