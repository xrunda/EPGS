import { runAuthCommand } from './auth-cli';

describe('auth CLI', () => {
  function setup(passwords = ['new-password', 'new-password']) {
    const store = {
      findByUsername: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      updatePassword: jest.fn(),
      create: jest.fn().mockResolvedValue({ username: 'doctor' }),
    };
    const hasher = {
      hash: jest.fn().mockResolvedValue('argon-hash'),
      verify: jest.fn(),
    };
    const promptHidden = jest.fn().mockImplementation(async () => passwords.shift() ?? '');
    const write = jest.fn();
    return { store, hasher, promptHidden, write };
  }

  it('creates a user from flags and two hidden password prompts', async () => {
    const deps = setup();
    await runAuthCommand(
      ['create-user', '--username', 'Doctor', '--display-name', '测试医生'],
      deps,
    );

    expect(deps.promptHidden).toHaveBeenCalledTimes(2);
    expect(deps.hasher.hash).toHaveBeenCalledWith('new-password');
    expect(deps.store.create).toHaveBeenCalledWith('doctor', '测试医生', 'argon-hash');
    expect(deps.write).toHaveBeenCalledWith('创建成功：doctor');
    expect(JSON.stringify(deps.write.mock.calls)).not.toMatch(/new-password|argon-hash/);
  });

  it('resets an existing password and increments passwordVersion through the store', async () => {
    const deps = setup();
    deps.store.findByUsername.mockResolvedValue({
      id: 'user-1',
      username: 'doctor',
      displayName: '测试医生',
      passwordHash: 'old-hash',
      passwordVersion: 4,
      isActive: true,
    });

    await runAuthCommand(['reset-password', '--username', 'doctor'], deps);

    expect(deps.store.updatePassword).toHaveBeenCalledWith('user-1', 'argon-hash', 4);
    expect(deps.write).toHaveBeenCalledWith('重置成功：doctor');
  });

  it.each([
    [
      ['create-user', '--username', 'doctor', '--display-name', '医生', '--password', 'leaked'],
      '不允许通过命令行参数传入密码',
    ],
    [['create-user', '--username', 'doctor'], '缺少参数 --display-name'],
  ])('rejects unsafe or incomplete arguments', async (args, message) => {
    await expect(runAuthCommand(args, setup())).rejects.toThrow(message);
  });

  it('rejects short or mismatched passwords before writing', async () => {
    const short = setup(['short', 'short']);
    short.store.findByUsername.mockResolvedValue({
      id: 'user-1',
      username: 'doctor',
      passwordVersion: 1,
    });
    await expect(runAuthCommand(['reset-password', '--username', 'doctor'], short)).rejects.toThrow(
      '密码至少需要 8 个字符',
    );
    expect(short.store.updatePassword).not.toHaveBeenCalled();

    const mismatch = setup(['new-password', 'different-password']);
    await expect(
      runAuthCommand(['create-user', '--username', 'doctor', '--display-name', '医生'], mismatch),
    ).rejects.toThrow('两次输入的密码不一致');
    expect(mismatch.store.create).not.toHaveBeenCalled();
  });
});
