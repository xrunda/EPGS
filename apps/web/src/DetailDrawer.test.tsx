import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  MonitorAiSemanticDto,
  MonitorExamWorkbenchDetailDto,
} from '@epgs/shared-types';
import { DetailDrawer } from './DetailDrawer';

/**
 * The workbench detail (issue #88): attentionSource / aiJudged / aiSemantics are
 * REQUIRED here, so a fixture cannot silently omit them and pass a test that
 * never exercised the new rendering.
 *
 * The base fixture is the pre-#88 shape: keywords found it, the AI was never
 * asked. Every AI-specific case below overrides from here.
 */
const detail: MonitorExamWorkbenchDetailDto = {
  recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  monitorLevel: 'RED',
  patientName: '测试患者甲',
  department: '内镜中心',
  bedNo: '12床',
  patientType: { code: 'I', name: '住院' },
  examItem: '胃镜',
  examDate: '2026-08-20',
  examTime: '10:30:00',
  matchedKeywords: ['腺癌'],
  reportContent: '胃体见多发隆起型病变，考虑腺癌。',
  diagnosis: '胃体腺癌。',
  hits: [
    {
      ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ruleVersion: 1,
      keyword: '腺癌',
      level: 'RED',
      matchedField: 'REPORT_TEXT',
      contextSnippet: '…胃体见多发隆起型病变，考虑腺癌。…',
      matchedAt: '2026-08-21T00:00:00.000Z',
      semanticFiltered: false,
      semantic: null,
    },
  ],
  attentionSource: 'RULE',
  aiJudged: false,
  aiSemantics: [],
};

/** Issue #88: a report-level finding, with the model's sentence and verbatim quotes. */
const aiFinding: MonitorAiSemanticDto = {
  semanticId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  semanticVersion: 2,
  name: '明确或高度疑似恶性病变',
  attentionLevel: 'RED',
  confidence: 'HIGH',
  reason: '报告描述了不规则隆起与质脆。',
  evidence: [
    { field: 'FINDINGS', text: '多发隆起型病变' },
    { field: 'IMPRESSION', text: '胃体腺癌' },
  ],
};

function withAi(
  overrides: Partial<MonitorExamWorkbenchDetailDto> = {},
): MonitorExamWorkbenchDetailDto {
  return {
    ...detail,
    attentionSource: 'BOTH',
    aiJudged: true,
    aiSemantics: [aiFinding],
    ...overrides,
  };
}

/** Serves one payload for every detail request for the duration of one test. */
function stubDetail(payload: MonitorExamWorkbenchDetailDto): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/monitor/exams/')) return jsonResponse(payload);
      return jsonResponse({ error: { message: '未找到' } }, 404);
    }),
  );
}

/**
 * The 「关注依据」 section on its own (issue #94: the old 命中证据 and AI 语义发现
 * sections are now one list). Since the summary's main level tag and every item's
 * own level tag spell the level the same way (「红色关注」, issue #92), a
 * whole-dialog text query for a level is ambiguous by design - scope the
 * assertions to the section that owns them.
 */
function reasonSection(dialog: HTMLElement): HTMLElement {
  const section = dialog.querySelector<HTMLElement>('.drawer__section--reasons');
  if (!section) throw new Error('关注依据 section is missing from the drawer');
  return section;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('DetailDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(detail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the report, diagnosis, and hit evidence for a record', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(within(dialog).getByText('测试患者甲')).toBeInTheDocument();
    expect(within(dialog).getByText('住院（I）')).toBeInTheDocument();

    // Report and diagnosis are highlighted in place, original text unchanged.
    const paragraphs = dialog.querySelectorAll('p.drawer__text');
    expect(paragraphs[0].textContent).toBe('胃体见多发隆起型病变，考虑腺癌。');
    expect(paragraphs[1].textContent).toBe('胃体腺癌。');
    const marks = dialog.querySelectorAll('mark.hit-highlight');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('腺癌');
    expect(marks[1].textContent).toBe('腺癌');

    // Issue #94: one sentence right under the level says why this patient is on
    // the list, before any evidence list.
    expect(dialog.querySelector('.drawer__reason')?.textContent).toBe(
      '报告内容或诊断中发现「腺癌」',
    );
    // The summary tag and the item's own tag spell the level the same way -
    // 红色关注 is now the only spelling inside the drawer (issue #94).
    expect(dialog.querySelector('.drawer__level-line .level-tag')?.textContent).toBe('红色关注');
    expect(within(dialog).getAllByText('红色关注')).toHaveLength(2);
    expect(within(dialog).queryByText('红色')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('腺癌')).toHaveLength(3);
    expect(within(dialog).getByText('报告内容与诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('…胃体见多发隆起型病变，考虑腺癌。…')).toBeInTheDocument();
    // Issue #94: the rule UUID and version are operational identifiers, no
    // longer on the clinical main line (the API still returns them).
    expect(within(dialog).queryByText(/规则 [0-9a-f]{8} · v\d/)).not.toBeInTheDocument();
  });

  it('shows placeholders when the report or diagnosis is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse({ ...detail, reportContent: null, diagnosis: null, hits: [] });
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(within(dialog).getByText('暂无报告内容')).toBeInTheDocument();
    expect(within(dialog).getByText('（未同步到报告正文）')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('暂无关注依据')).toBeInTheDocument();
  });

  it('highlights multiple matched keywords without altering the original text', async () => {
    const multiDetail: MonitorExamWorkbenchDetailDto = {
      ...detail,
      reportContent: '胃体见多发息肉样隆起，考虑腺癌。',
      diagnosis: '胃体腺癌伴多发息肉。',
      hits: [
        detail.hits[0],
        {
          ruleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ruleVersion: 1,
          keyword: '息肉',
          level: 'YELLOW',
          matchedField: 'REPORT_TEXT',
          contextSnippet: '…胃体见多发息肉样隆起…',
          matchedAt: '2026-08-21T00:00:00.000Z',
          semanticFiltered: false,
          semantic: null,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(multiDetail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    // 报告内容: 息肉 + 腺癌; 诊断: 腺癌 + 息肉 -> 4 marks total.
    const marks = dialog.querySelectorAll('mark.hit-highlight');
    expect(marks).toHaveLength(4);
    const [report, diagnosis] = dialog.querySelectorAll('p.drawer__text');
    expect(report.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
    expect(report.textContent).toBe('胃体见多发息肉样隆起，考虑腺癌。');
    expect(diagnosis.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
    expect(diagnosis.textContent).toBe('胃体腺癌伴多发息肉。');
  });

  it('renders no highlights when there are no hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse({ ...detail, hits: [] });
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(within(dialog).getByText('暂无关注依据')).toBeInTheDocument();
  });

  // Issue #87: a hit the AI judged not to express the rule's intent stays
  // visible (the keyword engine did fire) but is marked 未计入关注 and carries
  // the 结合上下文 line; it must NOT be highlighted as a reason for the visit.
  it('shows a filtered hit with its verdict but keeps it out of the highlights', async () => {
    const filteredDetail: MonitorExamWorkbenchDetailDto = {
      ...detail,
      reportContent: '胃窦黏膜光滑，未见明显溃疡。',
      diagnosis: '慢性胃炎。',
      hits: [
        {
          ruleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ruleVersion: 2,
          keyword: '溃疡',
          level: 'RED',
          matchedField: 'REPORT_TEXT',
          contextSnippet: '…未见明显溃疡…',
          matchedAt: '2026-08-21T00:00:00.000Z',
          semanticFiltered: true,
          semantic: {
            status: 'NEGATED',
            confidence: 'HIGH',
            reason: '该句是否认句，报告没有写存在溃疡。',
            judgedAt: '2026-08-21T00:05:00.000Z',
          },
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(filteredDetail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    // Highlighting means "this is why the patient is on the list" - a filtered
    // hit is precisely not that.
    expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(0);
    expect(dialog.querySelectorAll('p.drawer__text')[0].textContent).toBe(
      '胃窦黏膜光滑，未见明显溃疡。',
    );
    // The hit itself, and the count note, are still shown.
    expect(within(dialog).getByText('其中 1 条未计入关注')).toBeInTheDocument();
    expect(within(dialog).getByText('未计入关注')).toBeInTheDocument();
    const hit = dialog.querySelector('li.drawer__hit--filtered');
    expect(hit).not.toBeNull();
    expect(within(hit as HTMLElement).getByText('溃疡')).toBeInTheDocument();
    expect(within(hit as HTMLElement).getByText('报告是否定这个情况')).toBeInTheDocument();
    expect(within(hit as HTMLElement).getByText('（把握高）')).toBeInTheDocument();
    expect(
      within(hit as HTMLElement).getByText('该句是否认句，报告没有写存在溃疡。'),
    ).toBeInTheDocument();
    expect(dialog.querySelector('.drawer__hit-semantic-label')?.textContent).toBe('结合上下文');
  });

  it('does not invent a verdict for a hit that was never judged', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(within(dialog).queryByText('结合上下文')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/未计入关注/)).not.toBeInTheDocument();
    expect(dialog.querySelectorAll('li.drawer__hit--filtered')).toHaveLength(0);
  });

  it('shows a loading state while fetching the detail', () => {
    // A fetch that never settles keeps the drawer in its loading state; the
    // promise resolution after unmount would otherwise fire outside act().
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    expect(screen.getByText('正在加载检查详情…')).toBeInTheDocument();
  });

  it('moves keyboard focus into the dialog on open', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(dialog).toHaveFocus();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(<DetailDrawer recordId={detail.recordId} onClose={onClose} />);
    await screen.findByRole('dialog', { name: '检查详情' });

    fireEvent.click(screen.getByRole('button', { name: '关闭检查详情' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<DetailDrawer recordId={detail.recordId} onClose={onClose} />);
    await screen.findByRole('dialog', { name: '检查详情' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a friendly not-found message with a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse({ error: { message: '未找到' } }, 404)),
    );
    const onClose = vi.fn();
    render(<DetailDrawer recordId="missing" onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(await within(dialog).findByText('未找到该检查记录，可能已被移除。')).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/monitor/exams/')) {
          return jsonResponse(detail);
        }
        return jsonResponse({ error: { message: '未找到' } }, 404);
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '重新加载' }));
    // The reloaded detail re-renders the highlighted report text.
    await waitFor(() => {
      expect(dialog.querySelectorAll('mark.hit-highlight')).toHaveLength(2);
      expect(dialog.querySelectorAll('p.drawer__text')[0].textContent).toBe(
        '胃体见多发隆起型病变，考虑腺癌。',
      );
    });
  });

  it('renders nothing when no record is selected', () => {
    const { container } = render(<DetailDrawer recordId={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  // --- Issue #88: the report-level AI explanation --------------------------

  describe('关注理由 / level tags', () => {
    // Issue #92: the main level tag says 「关注」 too - 红色是管理上的关注等级，
    // 不是病情严重程度，抽屉与工作台行内标签用同一份文案。
    it.each([
      ['RED', '红色关注'],
      ['YELLOW', '黄色关注'],
      ['GREEN', '绿色关注'],
    ] as const)('spells the summary level tag %s as 「%s」', async (level, label) => {
      stubDetail({ ...detail, monitorLevel: level });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.drawer__level-line .level-tag')?.textContent).toBe(label);
    });

    // Issue #94: one sentence built from the record's own fields, covering all
    // four attention sources. NONE gets no sentence at all.
    it.each([
      ['RULE', '报告内容或诊断中发现「腺癌」'],
      ['BOTH', '报告内容或诊断中发现「腺癌」；报告提示「明确或高度疑似恶性病变」'],
    ] as const)('states the reason for a %s record as 「%s」', async (source, expected) => {
      stubDetail(withAi({ attentionSource: source }));
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.drawer__reason')?.textContent).toBe(expected);
    });

    it('says the report itself prompted the visit when no keyword matched', async () => {
      // The failure this exists for: a red record with zero keyword hits. The
      // sentence has to name what the report said, not leave the level bare.
      stubDetail(
        withAi({ attentionSource: 'AI_REPORT', hits: [], matchedKeywords: [] }),
      );
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.drawer__reason')?.textContent).toBe(
        '报告提示「明确或高度疑似恶性病变」',
      );
    });

    it('names the hit at the record level first, and counts the rest', async () => {
      const hits = [
        {
          ...detail.hits[0],
          keyword: '息肉',
          level: 'YELLOW' as const,
          matchedField: 'FINDINGS' as const,
        },
        detail.hits[0],
        {
          ...detail.hits[0],
          ruleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          keyword: '肿物',
          matchedField: 'IMPRESSION' as const,
        },
      ];
      stubDetail({ ...detail, hits, matchedKeywords: ['息肉', '腺癌', '肿物'] });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // 腺癌 is the RED one and the record is RED, so it is the one named even
      // though 息肉 matched first - the sentence explains the tag above it, and
      // it says which part of the report that hit came from.
      expect(dialog.querySelector('.drawer__reason')?.textContent).toBe(
        '报告内容或诊断中发现「腺癌」等 3 处',
      );
    });

    it('states no reason at all when nothing was found', async () => {
      stubDetail({
        ...detail,
        monitorLevel: 'UNCLASSIFIED',
        matchedKeywords: [],
        hits: [],
        attentionSource: 'NONE',
      });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.drawer__reason')).toBeNull();
      expect(dialog.querySelector('.source-badge')).toBeNull();
      expect(within(dialog).getByText('未分级')).toBeInTheDocument();
    });

    it('never names the machinery that produced the level', async () => {
      // Issue #94: the source badge is gone from the clinical view - the doctor
      // reads why the patient needs attention, not which engine found him.
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.source-badge')).toBeNull();
      const reason = dialog.querySelector('.drawer__reason')?.textContent ?? '';
      for (const leak of ['关键词', 'AI', '语义', '判读']) {
        expect(reason).not.toContain(leak);
      }
    });

    it('builds the reason for a masked caller from what it is still allowed to see', async () => {
      // Issue #13/#88 masking strips everything report-adjacent - the report
      // body, the hit's quote and verdict, the finding's sentence and quotes -
      // while the keyword, the matched field, the semantic name and the levels
      // survive (apps/api/src/access/data-scope.ts). The sentence has to come
      // out of exactly those survivors: read a stripped field and it would
      // either go blank or leak model prose to a caller with no report rights.
      stubDetail(
        withAi({
          reportContent: null,
          diagnosis: null,
          hits: [{ ...detail.hits[0], contextSnippet: '', semantic: null }],
          aiSemantics: [{ ...aiFinding, reason: null, evidence: [] }],
        }),
      );
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      const reason = dialog.querySelector('.drawer__reason')?.textContent;
      // Same sentence as the unmasked BOTH case above - the text did not
      // change, only the material it was allowed to read.
      expect(reason).toBe(
        '报告内容或诊断中发现「腺癌」；报告提示「明确或高度疑似恶性病变」',
      );
      for (const freeText of [
        '胃体见多发隆起型病变，考虑腺癌。',
        '胃体腺癌。',
        '报告描述了不规则隆起与质脆。',
        '…胃体见多发隆起型病变，考虑腺癌。…',
      ]) {
        expect(reason).not.toContain(freeText);
      }
    });
  });

  describe('关注依据', () => {
    it('renders each finding with its level, name, confidence, reason and quotes', async () => {
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // Issue #94: one section, one count over both kinds of evidence.
      expect(within(dialog).getByRole('heading', { name: /关注依据/ })).toBeInTheDocument();
      const reasons = reasonSection(dialog);
      expect(reasons.querySelectorAll('li')).toHaveLength(2);
      expect(within(reasons).getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
      // Both items are RED, and both say so with the same four characters.
      expect(within(reasons).getAllByText('红色关注')).toHaveLength(2);
      expect(within(reasons).getByText('把握高')).toBeInTheDocument();
      expect(within(reasons).getByText('报告描述了不规则隆起与质脆。')).toBeInTheDocument();
      // The hit and the finding are in the same list, both tagged the same way.
      expect(within(reasons).getByText('腺癌')).toBeInTheDocument();
      expect(reasons.querySelectorAll('li.drawer__hit')).toHaveLength(1);
      expect(reasons.querySelectorAll('li.drawer__ai-item')).toHaveLength(1);
      // The finding's level tag and the summary's main tag are the same word
      // now (issue #92) - both come from attentionSource.ts.
      expect(dialog.querySelector('.drawer__level-line .level-tag')?.textContent).toBe('红色关注');

      // Every quote carries the report field it came from, so a doctor can tell
      // a 报告内容 quote from a 诊断 one without guessing.
      const quotes = dialog.querySelectorAll('blockquote.drawer__ai-evidence');
      expect(quotes).toHaveLength(2);
      expect(quotes[0].textContent).toBe('报告内容多发隆起型病变');
      expect(quotes[1].textContent).toBe('诊断胃体腺癌');
      // The standing disclaimer, same sentence as the config page.
      expect(within(dialog).getByText('关注等级不是诊断结论，也不代表病情严重程度。')).toBeInTheDocument();
    });

    it('never rewrites the report body to build a quote', async () => {
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // The report and diagnosis paragraphs are still exactly what the server
      // sent - no slicing, no splicing quotes back in, no extra marks.
      const paragraphs = dialog.querySelectorAll('p.drawer__text');
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].textContent).toBe('胃体见多发隆起型病变，考虑腺癌。');
      expect(paragraphs[1].textContent).toBe('胃体腺癌。');
      // The quotes live in 关注依据, never inside the report body.
      expect(paragraphs[0].querySelectorAll('blockquote')).toHaveLength(0);
      expect(dialog.querySelectorAll('p.drawer__text blockquote')).toHaveLength(0);
    });

    it('keeps a masked finding as a verdict: no reason, no quotes, name and level intact', async () => {
      // What a caller without patientDetail rights receives (issue #13/#88).
      stubDetail(
        withAi({
          aiSemantics: [{ ...aiFinding, reason: null, evidence: [] }],
        }),
      );
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // Without the finding a record flagged only by the AI would be 红色关注
      // with nothing on screen to explain it.
      const reasons = reasonSection(dialog);
      expect(within(reasons).getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
      expect(within(reasons).getAllByText('红色关注')).toHaveLength(2);
      expect(within(reasons).getByText('把握高')).toBeInTheDocument();
      expect(dialog.querySelectorAll('blockquote.drawer__ai-evidence')).toHaveLength(0);
      expect(within(dialog).queryByText('报告描述了不规则隆起与质脆。')).not.toBeInTheDocument();
    });

    it('says the whole report was checked when it was judged and nothing was found', async () => {
      stubDetail({
        ...detail,
        attentionSource: 'RULE',
        aiJudged: true,
        aiSemantics: [],
      });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(within(dialog).getByText('整份报告已核对，未发现需要关注的内容')).toBeInTheDocument();
    });

    it('says nothing extra when the report was never judged', async () => {
      stubDetail({ ...detail, aiJudged: false, aiSemantics: [] });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // No claim either way: "we looked and found nothing" is a statement, and
      // the drawer must not make it when nobody looked.
      expect(
        within(dialog).queryByText('整份报告已核对，未发现需要关注的内容'),
      ).not.toBeInTheDocument();
    });

    it('sorts the merged list by level, hits before findings at the same level', async () => {
      const greenHit = {
        ...detail.hits[0],
        ruleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        keyword: '糜烂',
        level: 'GREEN' as const,
      };
      stubDetail(
        withAi({
          hits: [detail.hits[0], greenHit],
          matchedKeywords: ['腺癌', '糜烂'],
          aiSemantics: [
            {
              ...aiFinding,
              semanticId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              name: '值得记录的轻微表现',
              attentionLevel: 'GREEN',
              confidence: 'LOW',
              reason: null,
              evidence: [],
            },
            aiFinding,
          ],
        }),
      );
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // Deterministic order (issue #94): RED first, then GREEN; within a level
      // the hits keep the server's order and come before the findings - and the
      // GREEN finding stays below both RED ones even though the server put it
      // first in its own array.
      const items = Array.from(reasonSection(dialog).querySelectorAll('li'));
      expect(items).toHaveLength(4);
      expect(items[0].textContent).toContain('腺癌');
      expect(items[1].textContent).toContain('明确或高度疑似恶性病变');
      expect(items[2].textContent).toContain('糜烂');
      expect(items[3].textContent).toContain('值得记录的轻微表现');
    });

    it('uses only doctor-facing wording, never the implementation vocabulary', async () => {
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      const rendered = dialog.textContent ?? '';
      for (const leak of [
        '关键词监控',
        'AI 语义监控',
        '语义',
        '判读',
        'Prompt',
        '提示词',
        'Semantic',
        'LLM',
        'Classifier',
        '分类器',
        'JSON',
        '模型',
        '大模型',
        'Schema',
        '置信度',
        '哈希',
      ]) {
        expect(rendered).not.toContain(leak);
      }
      // Positive controls: the agreed wording really is on screen, so the scan
      // above cannot pass by rendering nothing.
      expect(rendered).toContain('关注依据');
      expect(rendered).toContain('关注等级不是诊断结论');
      // Issue #87's lines survive inside the merged list.
      expect(rendered).toContain('报告内容与诊断');
    });
  });
});
