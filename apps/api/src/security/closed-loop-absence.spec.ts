import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Static, DB-free regression tripwire for the "no closed-loop reporting"
 * product rule (epic #15 + issue #14 scenario 10): the page and the API must
 * expose NO 待上报/已上报/已知晓/已处理/误报/日报 (report/acknowledge/handle/
 * false-positive/daily) capability anywhere. The closed-loop data model was
 * removed in issue #26; this spec makes any future regression loud and local
 * instead of silently shipping a partial closed-loop surface.
 *
 * Checks, all on non-test production source:
 *   a. prisma schema: no MonitorAction model, no monitor_action /
 *      handling_status / report_status field mappings (comment lines are
 *      ignored - they legitimately document the removal).
 *   b. api routes: no @Controller/@Get/@Post/@Put/@Delete/@Patch path
 *      literal contains a closed-loop fragment. Only route-path string
 *      literals are scanned, so property names like `reportContent` /
 *      `reportId` (which contain "report") can never false-positive.
 *   c. shared-types: no closed-loop type names (ReportStatus /
 *      HandlingStatus / MonitorAction / DispositionStatus).
 *   d. web UI: no closed-loop entry labels (待上报/已上报/已知晓/已处理/误报/
 *      日报) in non-test source, and no /api/ call targets a closed-loop path.
 *
 * Best-effort tripwire, not a proof of absence - mirror of
 * log-sanitization.spec.ts's walk-and-scan style.
 */

const CLOSED_LOOP_ROUTE_FRAGMENTS = /report|disposition|acknowledge|handling|daily|action/i;
const CLOSED_LOOP_SCHEMA_MAP =
  /@map\("[^"]*(?:handling_status|report_status|monitor_action)[^"]*"\)/;
const CLOSED_LOOP_TYPE_NAMES =
  /\b(?:ReportStatus|HandlingStatus|MonitorAction|DispositionStatus)\b/;
const CLOSED_LOOP_UI_LABELS = /待上报|已上报|已知晓|已处理|误报|日报/;
const ROUTE_DECORATOR = /@(?:Controller|Get|Post|Put|Delete|Patch)\(\s*(['"])([^'"]*)\1/g;

function walk(dir: string, files: string[] = [], exts: string[] = ['.ts']): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files, exts);
    else if (exts.some((ext) => full.endsWith(ext))) files.push(full);
  }
  return files;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

const apiSrc = join(__dirname, '..');
const schemaPath = join(__dirname, '../../prisma/schema.prisma');
const sharedTypesSrc = join(__dirname, '../../../../packages/shared-types/src');
const webSrc = join(__dirname, '../../../web/src');

const controllerFiles = walk(apiSrc).filter((file) => file.endsWith('.controller.ts'));
const sharedTypeFiles = walk(sharedTypesSrc);
const webFiles = walk(webSrc, [], ['.ts', '.tsx']).filter(
  (file) => !/\.test\.(ts|tsx)$/.test(file),
);

describe('closed-loop reporting surface is absent (issue #14 scenario 10)', () => {
  it('prisma schema defines no closed-loop model or field mapping', () => {
    const lines = read(schemaPath)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'));
    const text = lines.join('\n');
    expect(/\bmodel MonitorAction\b/.test(text)).toBe(false);
    expect(CLOSED_LOOP_SCHEMA_MAP.test(text)).toBe(false);
  });

  it('no API controller route path contains a closed-loop fragment', () => {
    const violations: string[] = [];
    for (const file of controllerFiles) {
      for (const match of read(file).matchAll(ROUTE_DECORATOR)) {
        const path = match[2];
        if (CLOSED_LOOP_ROUTE_FRAGMENTS.test(path)) {
          violations.push(`${path} in ${relative(process.cwd(), file)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('shared-types defines no closed-loop type names', () => {
    const violations = sharedTypeFiles
      .filter((file) => !/\.spec\.ts$/.test(file))
      .filter((file) => CLOSED_LOOP_TYPE_NAMES.test(read(file)))
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it('web UI source has no closed-loop entry labels and no closed-loop /api/ targets', () => {
    const labelViolations: string[] = [];
    const urlViolations: string[] = [];
    for (const file of webFiles) {
      const content = read(file);
      if (CLOSED_LOOP_UI_LABELS.test(content)) {
        labelViolations.push(relative(process.cwd(), file));
      }
      for (const url of content.matchAll(/['"](\/api\/[^'"]+)['"]/g)) {
        if (CLOSED_LOOP_ROUTE_FRAGMENTS.test(url[1])) {
          urlViolations.push(`${url[1]} in ${relative(process.cwd(), file)}`);
        }
      }
    }
    expect(labelViolations).toEqual([]);
    expect(urlViolations).toEqual([]);
  });
});
