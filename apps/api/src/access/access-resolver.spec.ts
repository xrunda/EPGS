import { AccessResolver } from './access-resolver';

describe('AccessResolver (issue #13)', () => {
  it('maps an existing app_user_access row to an AccessUser', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      username: 'doctor',
      roles: ['VIEWER', 'RULE_ADMIN'],
      departmentScope: ['消化内科'],
      patientDetail: true,
      updatedAt: new Date('2026-08-21T00:00:00Z'),
    });
    const resolver = new AccessResolver({ appUserAccess: { findUnique } } as never);

    const user = await resolver.resolveByUsername('doctor');

    expect(user).toEqual({
      username: 'doctor',
      roles: ['VIEWER', 'RULE_ADMIN'],
      departmentScope: ['消化内科'],
      patientDetail: true,
    });
    expect(findUnique).toHaveBeenCalledWith({ where: { username: 'doctor' } });
  });

  it('returns null when the account has no access row (fail-closed)', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const resolver = new AccessResolver({ appUserAccess: { findUnique } } as never);

    await expect(resolver.resolveByUsername('nobody')).resolves.toBeNull();
  });
});
