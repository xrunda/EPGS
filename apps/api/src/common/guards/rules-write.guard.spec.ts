import { RulesWriteGuard } from './rules-write.guard';

/**
 * This guard is a deliberate placeholder (see its doc comment) until
 * issue #13 ships real authentication/authorization. This spec exists so
 * the "unauthorized access" test scenario issue #4's acceptance criteria
 * asks for has a concrete seam: once #13 implements real checks here,
 * this file is where the "rejects an unauthorized caller" case should be
 * added/updated - flip the `it.todo` below to a real assertion then.
 */
describe('RulesWriteGuard', () => {
  it('currently allows all requests through (placeholder, not real auth)', () => {
    const guard = new RulesWriteGuard();
    expect(guard.canActivate({} as any)).toBe(true);
  });

  // Intentionally not implemented: no real auth exists yet (issue #13).
  // Keeping this as an explicit, named TODO (rather than omitting it)
  // documents the gap in the test suite itself, per issue #4's ask to
  // "leave the unauthorized-access test structure in place".
  it.todo('rejects a request from an unauthorized/unauthenticated caller (issue #13)');
});
