import { DEFAULT_ATTENTION_SEMANTICS } from './defaults';

/**
 * Unit tests on the preset list itself - the only place these values are stated.
 *
 * WHAT THEY DO NOT COVER, deliberately: whether any of these wordings is
 * medically right for a given hospital. They are generic endoscopy phrasing
 * written for this system, and the file says so; a test cannot check a medical
 * claim, and asserting one here would dress a guess up as a guarantee.
 *
 * What they DO cover is the small set of structural properties that
 * `importDefaults` relies on, plus the wording contract the classifier depends
 * on: a description that states a conclusion instead of naming report content
 * gives the model nothing to match against, so that is checked mechanically.
 */
describe('DEFAULT_ATTENTION_SEMANTICS', () => {
  const VALID_LEVELS = ['RED', 'YELLOW', 'GREEN'];

  it('has a unique name per preset, because import-defaults matches by name', () => {
    // `importDefaults` looks each preset up by name among ENABLED rows
    // (case-insensitively). Two presets sharing a name would collapse into one
    // row: the second would be reported as "skipped" and never created, so the
    // hospital would silently end up with a configuration nobody chose.
    const names = DEFAULT_ATTENTION_SEMANTICS.map((preset) => preset.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every preset a real level and a description that names evidence', () => {
    for (const preset of DEFAULT_ATTENTION_SEMANTICS) {
      expect(VALID_LEVELS).toContain(preset.attentionLevel);
      expect(preset.description.trim()).not.toBe('');

      // The description IS the prompt: it is what the classifier is asked to
      // match a report against. The header comment states the contract ("each
      // one names the kind of report content that would justify it"), so this
      // fails on a description that only asserts a conclusion, and on one
      // shortened to a label.
      expect(preset.description).toContain('例如');
      expect(preset.description.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('covers benign organic or functional findings that still need follow-up (#100)', () => {
    // Round 1 of the replay acceptance run (2026-09-26) surfaced this gap: the
    // keyword tables carry 贲门失弛缓症 / 食管裂孔疝 as RED keywords, but no
    // preset meaning covered them, so the classifier - correctly, per its
    // configuration - reported no finding for two cases the dataset labels
    // SHOULD_FIND. Malignancy, bleeding, indeterminate, post-treatment,
    // multi-focal and interval-change wording all miss them: they are benign
    // lesions that need management, not suspected cancer.
    const benign = DEFAULT_ATTENTION_SEMANTICS.find(
      (preset) => preset.name === '良性器质性或功能性病变（需处理或随访）',
    );

    expect(benign).toBeDefined();
    // YELLOW: worth a doctor's eyes, but the meaning is "there is something to
    // follow up", not "this might be cancer".
    expect(benign?.attentionLevel).toBe('YELLOW');
    expect(benign?.description).toContain('贲门失弛缓症');
    expect(benign?.description).toContain('食管裂孔疝');
  });
});
