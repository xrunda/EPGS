import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Static, DB-free guard against committing secrets or logging patient data
 * (issue #13). Runs on every unit-test run (CI DB-free job), scanning
 * production source only:
 *
 *   a. No literal connection strings / JWT secrets / private keys / bearer
 *      tokens in api or worker source. Test fixtures are excluded - they
 *      legitimately contain fake credentials (e.g. the PACS adapter spec's
 *      "Bearer super-secret-token").
 *   b. No logger/console call may interpolate a HIGH-sensitivity patient
 *      field (patientName/reportContent/diagnosis/contextSnippet).
 *   c. The authorization surface must stay role-based: no permission-named
 *      identifiers (REPORT_ACCESS/DISPOSITION/EXPORT) that would imply a
 *      permissions matrix instead of the four-role design.
 *
 * This is a best-effort tripwire, not a replacement for review - the goal
 * is to make a regression loud and local rather than to prove absence.
 */

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

const apiSrc = join(__dirname, '..');
const workerSrc = join(__dirname, '../../../worker/src');
const sharedTypesSrc = join(__dirname, '../../../../packages/shared-types/src');

const allSourceFiles = [...walk(apiSrc), ...walk(workerSrc)];
// Test fixtures deliberately contain fake credentials - exclude them from the
// secrets check (b/c still apply).
const nonSpecSourceFiles = allSourceFiles.filter((file) => !/\.spec\.ts$/.test(file));
const authSurfaceFiles = [...allSourceFiles, ...walk(sharedTypesSrc)];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('log-sanitization / secrets tripwire (issue #13)', () => {
  it('production source contains no literal connection strings, JWT secrets, private keys, or bearer tokens', () => {
    const patterns: { label: string; regex: RegExp }[] = [
      { label: 'connection string', regex: /postgres(?:ql)?:\/\/[^'"\s]*@/ },
      { label: 'JWT_SECRET assignment', regex: /JWT_SECRET\s*=\s*["']?[A-Za-z0-9]/ },
      { label: 'private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
      { label: 'bearer token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/ },
    ];
    const violations: string[] = [];
    for (const file of nonSpecSourceFiles) {
      for (const { label, regex } of patterns) {
        if (regex.test(read(file))) violations.push(`${label} in ${relative(process.cwd(), file)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no logger/console call interpolates a HIGH-sensitivity patient field', () => {
    const regex =
      /(logger|console)\.(log|warn|error|info|debug|verbose)\s*\([^)]*(patientName|reportContent|diagnosis|contextSnippet)/;
    const violations = allSourceFiles
      .filter((file) => regex.test(read(file)))
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it('the authorization surface is role-based (no permission-named identifiers)', () => {
    const regex = /\b(REPORT_ACCESS|DISPOSITION|EXPORT)\b/;
    // Production source only - spec files legitimately reference the
    // forbidden names in assertions/docs about this very check.
    const violations = authSurfaceFiles
      .filter((file) => !/\.spec\.ts$/.test(file))
      .filter((file) => regex.test(read(file)))
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });
});
