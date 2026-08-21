import 'dotenv/config';
import { AppRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessUser } from './access-user';

type Command = 'assign-access' | 'show-access';

interface CliDependencies {
  findAccess(username: string): Promise<AccessUser | null>;
  upsertAccess(input: {
    username: string;
    roles: AppRole[];
    departmentScope: string[];
    patientDetail: boolean;
  }): Promise<void>;
  write(message: string): void;
}

export class AccessCliError extends Error {}

const VALID_ROLES: readonly AppRole[] = ['VIEWER', 'RULE_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR'];

interface ParsedArgs {
  command: Command;
  username: string;
  roles?: AppRole[];
  departments?: string[];
  patientDetail?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const [command, ...flags] = args;
  if (command !== 'assign-access' && command !== 'show-access') {
    throw new AccessCliError('命令必须是 assign-access 或 show-access');
  }

  const values = new Map<string, string>();
  const booleanFlags = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--patient-detail' || flag === '--no-patient-detail') {
      booleanFlags.add(flag);
      continue;
    }
    const value = flags[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new AccessCliError(`参数格式错误：${flag ?? ''}`);
    }
    values.set(flag, value);
    index += 1;
  }

  const username = values.get('--username')?.trim().toLowerCase();
  if (!username) throw new AccessCliError('缺少参数 --username');

  if (command === 'show-access') {
    return { command, username };
  }

  const rawRoles = values.get('--roles');
  if (!rawRoles) throw new AccessCliError('缺少参数 --roles（至少一个角色，逗号分隔）');
  const roleStrings = rawRoles.split(',').map((role) => role.trim().toUpperCase());
  for (const role of roleStrings) {
    if (!VALID_ROLES.includes(role as AppRole)) {
      throw new AccessCliError(`非法角色：${role}（可选：${VALID_ROLES.join(', ')}）`);
    }
  }
  const roles = roleStrings as AppRole[];

  const departments = (values.get('--departments') ?? '')
    .split(',')
    .map((department) => department.trim())
    .filter((department) => department.length > 0);

  const patientDetail = booleanFlags.has('--patient-detail');
  if (booleanFlags.has('--no-patient-detail') && patientDetail) {
    throw new AccessCliError('--patient-detail 与 --no-patient-detail 不能同时使用');
  }

  return { command, username, roles, departments, patientDetail };
}

/**
 * Assigns or shows a user's access grant. Pure-ish: all DB access goes
 * through the injected deps, so the spec can test parsing/validation/logic
 * with fakes and no DATABASE_URL (mirrors auth-cli.ts, issue #31).
 */
export async function runAccessCommand(args: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.command === 'show-access') {
    const access = await deps.findAccess(parsed.username);
    if (!access) throw new AccessCliError(`该账号没有访问授权记录：${parsed.username}`);
    deps.write(JSON.stringify(access, null, 2));
    return;
  }

  if (parsed.departments!.length === 0) {
    deps.write('警告：未指定 --departments，该用户将拥有全部科室的访问范围。');
  }
  await deps.upsertAccess({
    username: parsed.username,
    roles: parsed.roles!,
    departmentScope: parsed.departments!,
    patientDetail: parsed.patientDetail ?? false,
  });
  deps.write(`已保存 ${parsed.username} 的访问授权。`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  try {
    await runAccessCommand(process.argv.slice(2), {
      findAccess: async (username) => {
        const row = await prisma.appUserAccess.findUnique({ where: { username } });
        if (!row) return null;
        return {
          username: row.username,
          roles: row.roles,
          departmentScope: row.departmentScope,
          patientDetail: row.patientDetail,
        };
      },
      upsertAccess: async (input) => {
        await prisma.appUserAccess.upsert({
          where: { username: input.username },
          create: input,
          update: {
            roles: input.roles,
            departmentScope: input.departmentScope,
            patientDetail: input.patientDetail,
          },
        });
      },
      write: (message) => process.stdout.write(`${message}\n`),
    });
  } catch (error) {
    const message =
      error instanceof AccessCliError ? error.message : '操作失败，请检查数据库连接或账号状态';
    process.stderr.write(`失败：${message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main();
}
