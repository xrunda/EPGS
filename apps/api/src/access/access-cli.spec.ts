import { AccessCliError, runAccessCommand } from './access-cli';

type CliDeps = Parameters<typeof runAccessCommand>[1];

function setup(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    findAccess: jest.fn().mockResolvedValue(null),
    upsertAccess: jest.fn().mockResolvedValue(undefined),
    write: jest.fn(),
    ...overrides,
  };
}

describe('access CLI (issue #13)', () => {
  it('assigns access from flags, uppercases roles and trims departments', async () => {
    const deps = setup();
    await runAccessCommand(
      [
        'assign-access',
        '--username',
        'Doctor',
        '--roles',
        'viewer, RULE_ADMIN',
        '--departments',
        ' 消化内科 ,呼吸内科 ',
      ],
      deps,
    );

    expect(deps.upsertAccess).toHaveBeenCalledWith({
      username: 'doctor',
      roles: ['VIEWER', 'RULE_ADMIN'],
      departmentScope: ['消化内科', '呼吸内科'],
      patientDetail: false,
    });
    expect(deps.write).toHaveBeenCalledWith('已保存 doctor 的访问授权。');
  });

  it('sets patientDetail when --patient-detail is present', async () => {
    const deps = setup();
    await runAccessCommand(
      ['assign-access', '--username', 'doctor', '--roles', 'VIEWER', '--patient-detail'],
      deps,
    );
    expect(deps.upsertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ patientDetail: true }),
    );
  });

  it('warns loudly when --departments is omitted (empty scope = all departments)', async () => {
    const deps = setup();
    await runAccessCommand(['assign-access', '--username', 'doctor', '--roles', 'VIEWER'], deps);
    expect(deps.write).toHaveBeenCalledWith(
      '警告：未指定 --departments，该用户将拥有全部科室的访问范围。',
    );
    expect(deps.upsertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ departmentScope: [] }),
    );
  });

  it('rejects an illegal role', async () => {
    const deps = setup();
    await expect(
      runAccessCommand(['assign-access', '--username', 'doctor', '--roles', 'SUPER_USER'], deps),
    ).rejects.toThrow(/非法角色/);
    expect(deps.upsertAccess).not.toHaveBeenCalled();
  });

  it('accepts USER_ADMIN (issue #78/#79 cold-start: bootstrapping the first Web-admin account)', async () => {
    const deps = setup();
    await runAccessCommand(
      ['assign-access', '--username', 'admin', '--roles', 'USER_ADMIN'],
      deps,
    );
    expect(deps.upsertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['USER_ADMIN'] }),
    );
  });

  it('rejects a missing --username', async () => {
    const deps = setup();
    await expect(runAccessCommand(['assign-access', '--roles', 'VIEWER'], deps)).rejects.toThrow(
      /缺少参数 --username/,
    );
  });

  it('rejects --patient-detail together with --no-patient-detail', async () => {
    const deps = setup();
    await expect(
      runAccessCommand(
        [
          'assign-access',
          '--username',
          'doctor',
          '--roles',
          'VIEWER',
          '--patient-detail',
          '--no-patient-detail',
        ],
        deps,
      ),
    ).rejects.toThrow(/不能同时使用/);
  });

  it('prints the grant as JSON for show-access', async () => {
    const grant = {
      username: 'doctor',
      roles: ['VIEWER'],
      departmentScope: ['消化内科'],
      patientDetail: true,
    };
    const deps = setup({ findAccess: jest.fn().mockResolvedValue(grant) });
    await runAccessCommand(['show-access', '--username', 'doctor'], deps);
    expect(deps.write).toHaveBeenCalledWith(JSON.stringify(grant, null, 2));
  });

  it('fails with a non-zero message when show-access finds no grant', async () => {
    const deps = setup();
    await expect(runAccessCommand(['show-access', '--username', 'nobody'], deps)).rejects.toThrow(
      AccessCliError,
    );
  });
});
