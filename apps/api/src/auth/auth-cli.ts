import 'dotenv/config';
import { AuthUserStore, PasswordHasher } from './auth.types';
import { Argon2PasswordHasher } from './password-hasher.service';
import { PrismaAuthUserStore } from './prisma-auth-user.store';
import { PrismaService } from '../prisma/prisma.service';

type Command = 'create-user' | 'reset-password';

interface CliDependencies {
  store: AuthUserStore;
  hasher: PasswordHasher;
  promptHidden(prompt: string): Promise<string>;
  write(message: string): void;
}

export class AuthCliError extends Error {}

function parseArgs(args: string[]): { command: Command; username: string; displayName?: string } {
  const [command, ...flags] = args;
  if (command !== 'create-user' && command !== 'reset-password') {
    throw new AuthCliError('命令必须是 create-user 或 reset-password');
  }
  if (flags.some((flag) => flag === '--password' || flag.startsWith('--password='))) {
    throw new AuthCliError('不允许通过命令行参数传入密码');
  }

  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new AuthCliError(`参数格式错误：${flag ?? ''}`);
    }
    values.set(flag, value);
  }

  const username = values.get('--username')?.trim().toLowerCase();
  if (!username) throw new AuthCliError('缺少参数 --username');
  const displayName = values.get('--display-name')?.trim();
  if (command === 'create-user' && !displayName) {
    throw new AuthCliError('缺少参数 --display-name');
  }
  return { command, username, displayName };
}

async function collectPassword(promptHidden: CliDependencies['promptHidden']): Promise<string> {
  const password = await promptHidden('请输入新密码：');
  const confirmation = await promptHidden('请再次输入新密码：');
  if (password.length < 8) throw new AuthCliError('密码至少需要 8 个字符');
  if (password !== confirmation) throw new AuthCliError('两次输入的密码不一致');
  return password;
}

export async function runAuthCommand(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);
  const existing = await deps.store.findByUsername(parsed.username);
  if (parsed.command === 'create-user' && existing) {
    throw new AuthCliError(`账号已存在：${parsed.username}`);
  }
  if (parsed.command === 'reset-password' && !existing) {
    throw new AuthCliError(`账号不存在：${parsed.username}`);
  }

  const passwordHash = await deps.hasher.hash(await collectPassword(deps.promptHidden));
  if (parsed.command === 'create-user') {
    await deps.store.create(parsed.username, parsed.displayName!, passwordHash);
    deps.write(`创建成功：${parsed.username}`);
    return;
  }

  await deps.store.updatePassword(existing!.id, passwordHash, existing!.passwordVersion);
  deps.write(`重置成功：${parsed.username}`);
}

export function readHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new AuthCliError('必须在交互式终端中执行该命令'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') {
        finish();
        reject(new AuthCliError('操作已取消'));
      } else if (text === '\r' || text === '\n') {
        finish();
        resolve(value);
      } else if (text === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += text;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  try {
    await runAuthCommand(process.argv.slice(2), {
      store: new PrismaAuthUserStore(prisma),
      hasher: new Argon2PasswordHasher(),
      promptHidden: readHiddenPassword,
      write: (message) => process.stdout.write(`${message}\n`),
    });
  } catch (error) {
    const message =
      error instanceof AuthCliError ? error.message : '操作失败，请检查数据库连接或账号状态';
    process.stderr.write(`失败：${message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main();
}
