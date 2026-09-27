import { ValidationPipe } from '@nestjs/common';
import { LEVEL_CONFLICT_DEFAULT_DAYS, LEVEL_CONFLICT_MAX_DAYS } from '@epgs/shared-types';
import { ListLevelConflictsQueryDto } from './list-level-conflicts.query.dto';

/**
 * The query DTO against a REAL ValidationPipe, configured exactly as main.ts
 * configures it.
 *
 * Testing `parseOptionalBoolean` directly would prove nothing here: the bug this
 * pins is in the pipeline, not the function. `enableImplicitConversion: true`
 * runs `Boolean(...)` over the query string BEFORE a custom transform is called,
 * so a naive `?read=false` arrives as `true` - the opposite of what was asked.
 * Only an end-to-end trip through the pipe shows that.
 */
describe('ListLevelConflictsQueryDto (issue #103)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  function parse(query: Record<string, unknown>): Promise<ListLevelConflictsQueryDto> {
    return pipe.transform(query, { type: 'query', metatype: ListLevelConflictsQueryDto });
  }

  it('defaults the window when it is not asked for', async () => {
    const dto = await parse({});

    expect(dto.days).toBe(LEVEL_CONFLICT_DEFAULT_DAYS);
    expect(dto.read).toBeUndefined();
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('reads ?read=%s as the boolean it says', async (raw, expected) => {
    await expect(parse({ read: raw })).resolves.toMatchObject({ read: expected });
  });

  it('treats an empty value as "not asked for", not as false', async () => {
    // `?read=` is how a form field that was left blank arrives; it must not
    // silently become a filter.
    await expect(parse({ read: '' })).resolves.toMatchObject({ read: undefined });
  });

  it('rejects a value that is neither of the two, rather than guessing', async () => {
    await expect(parse({ read: 'yes' })).rejects.toBeDefined();
  });

  it.each([['0'], [String(LEVEL_CONFLICT_MAX_DAYS + 1)], ['-1']])(
    'rejects the out-of-range window %s instead of clamping it',
    async (days) => {
      await expect(parse({ days })).rejects.toBeDefined();
    },
  );

  it('accepts both ends of the window', async () => {
    await expect(parse({ days: '1' })).resolves.toMatchObject({ days: 1 });
    await expect(parse({ days: String(LEVEL_CONFLICT_MAX_DAYS) })).resolves.toMatchObject({
      days: LEVEL_CONFLICT_MAX_DAYS,
    });
  });

  it('refuses an unknown parameter instead of ignoring it', async () => {
    // The global pipe is whitelist + forbidNonWhitelisted, so a typo is a 400
    // rather than a silently dropped filter.
    await expect(parse({ record: 'anything' })).rejects.toBeDefined();
  });
});
