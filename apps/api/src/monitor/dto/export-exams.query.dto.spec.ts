import { ValidationPipe } from '@nestjs/common';
import { ExportExamsQueryDto } from './export-exams.query.dto';

/**
 * The export query DTO against a REAL ValidationPipe, configured exactly as
 * main.ts configures it (issue #139, multi-level since #145).
 *
 * Calling `parseLevels` directly would prove nothing about the part that is
 * actually fragile: `enableImplicitConversion: true` rewrites a query value
 * toward the declared property type BEFORE a custom `@Transform` runs, so a
 * single `?levels=RED,YELLOW` reaches the transform already coerced - and the
 * comma inside it is only visible via the raw source object. Only a trip
 * through the pipe shows whether the DTO survives that.
 */
describe('ExportExamsQueryDto (issue #139, multi-level since #145)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  function parse(query: Record<string, unknown>): Promise<ExportExamsQueryDto> {
    return pipe.transform(query, { type: 'query', metatype: ExportExamsQueryDto });
  }

  describe('levels: one parameter, comma-separated', () => {
    it('reads ?levels=RED as the one-element selection it means', async () => {
      // The regression that matters most: `Array` as the declared type makes
      // implicit conversion wrap a bare string, and a naive implementation
      // would emit the single level "RED," or ["RED"] vs ["R","E","D"].
      await expect(parse({ examDate: '2026-08-20', levels: 'RED' })).resolves.toMatchObject({
        levels: ['RED'],
      });
    });

    it('splits a comma-separated selection and keeps the canonical order', async () => {
      await expect(parse({ examDate: '2026-08-20', levels: 'YELLOW,RED' })).resolves.toMatchObject({
        levels: ['RED', 'YELLOW'],
      });
    });

    it('accepts the repeated-parameter form too - Nest hands it over as an array', async () => {
      await expect(
        parse({ examDate: '2026-08-20', levels: ['GREEN', 'RED'] }),
      ).resolves.toMatchObject({ levels: ['RED', 'GREEN'] });
    });

    it('ignores surrounding whitespace and trailing commas', async () => {
      // `levels=RED, YELLOW,` is what a hand-written URL or a copy-paste looks
      // like. Rejecting it would be pedantry; the choice is unambiguous.
      await expect(
        parse({ examDate: '2026-08-20', levels: ' RED , YELLOW ,' }),
      ).resolves.toMatchObject({ levels: ['RED', 'YELLOW'] });
    });

    it('collapses duplicates instead of failing or exporting the level twice', async () => {
      // The checkbox UI cannot produce this, but the query string is public -
      // and `RED,RED,RED,RED` must not become an `in (RED,RED,RED,RED)` clause
      // or a file named 红色关注+红色关注+红色关注+红色关注.
      await expect(
        parse({ examDate: '2026-08-20', levels: 'RED,RED,RED,RED,RED' }),
      ).resolves.toMatchObject({ levels: ['RED'] });
      // Mixed case: the duplicate collapses AND the order is normalised, so the
      // same selection cannot produce two different filenames.
      await expect(
        parse({ examDate: '2026-08-20', levels: 'YELLOW,RED,YELLOW' }),
      ).resolves.toMatchObject({ levels: ['RED', 'YELLOW'] });
    });

    it('accepts all four levels - the whole day in one file (#145 made this reachable)', async () => {
      await expect(
        parse({ examDate: '2026-08-20', levels: 'UNCLASSIFIED,GREEN,YELLOW,RED' }),
      ).resolves.toMatchObject({ levels: ['RED', 'YELLOW', 'GREEN', 'UNCLASSIFIED'] });
    });

    it.each([
      ['an unknown level name', 'RED,PURPLE'],
      ['a lower-case level', 'red'],
      ['a Chinese label instead of the code', '红色关注'],
      ['an empty value', ''],
      ['only separators', ', ,'],
    ])('rejects %s rather than exporting a quietly narrower file', async (_label, levels) => {
      await expect(parse({ examDate: '2026-08-20', levels })).rejects.toBeDefined();
    });

    it('requires the parameter at all', async () => {
      await expect(parse({ examDate: '2026-08-20' })).rejects.toBeDefined();
    });
  });

  describe('the pre-#145 contract is gone, not aliased', () => {
    it('rejects ?level=RED (singular)', async () => {
      // Deliberate: keeping the old name as an alias would leave the
      // single-level contract in the API forever, and a caller that still sends
      // it is asking for something the endpoint no longer means. Because the
      // global pipe is forbidNonWhitelisted, this is a 400 - not a silently
      // ignored filter that exports the whole day.
      await expect(parse({ examDate: '2026-08-20', level: 'RED' })).rejects.toBeDefined();
    });
  });

  describe('examDate', () => {
    it('accepts a plain YYYY-MM-DD date', async () => {
      await expect(parse({ examDate: '2026-08-20', levels: 'RED' })).resolves.toMatchObject({
        examDate: '2026-08-20',
      });
    });

    it.each([
      ['an ISO timestamp', '2026-08-20T00:00:00Z'],
      ['a slashed date', '2026/08/20'],
      ['a month and day without the year', '08-20'],
      ['a date with a time glued on', '2026-08-20 00:00'],
      ['an empty value', ''],
    ])('rejects %s', async (_label, examDate) => {
      await expect(parse({ examDate, levels: 'RED' })).rejects.toBeDefined();
    });

    it('checks the SHAPE here and leaves the calendar to the service, by design', async () => {
      // `2026-13-45` has the right shape and passes this DTO - that is not a
      // hole to patch here. `resolveDateRange` (monitor-time.ts) exists exactly
      // for this: it round-trips the components and throws a 400
      // INVALID_DATE_PARAM, because V8's ISO parser SILENTLY normalises an
      // impossible date (2026-02-31 -> 2026-03-02) rather than producing an
      // Invalid Date. Pinning the split here so a later "tighten the regex"
      // change does not silently move the calendar rule into two places.
      await expect(parse({ examDate: '2026-13-45', levels: 'RED' })).resolves.toMatchObject({
        examDate: '2026-13-45',
      });
    });

    it('requires the parameter', async () => {
      await expect(parse({ levels: 'RED' })).rejects.toBeDefined();
    });
  });

  describe('the filter surface cannot be smuggled in', () => {
    it.each([
      ['department', { department: '消化内科' }],
      ['examDateFrom', { examDateFrom: '2026-08-01' }],
      ['page', { page: '1' }],
      ['patientName', { patientName: '张三' }],
      ['keyword', { keyword: '隆起' }],
    ])('refuses the leftover workbench parameter %s', async (_label, extra) => {
      // A caller must not be able to widen the file past the two choices the
      // modal shows, nor pull in a patient name filter the audit trail
      // deliberately never records.
      await expect(
        parse({ examDate: '2026-08-20', levels: 'RED', ...extra }),
      ).rejects.toBeDefined();
    });
  });
});
