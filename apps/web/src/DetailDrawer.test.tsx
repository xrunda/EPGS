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

    // The red label appears on the summary tag and the hit tag; the keyword
    // also shows in the two highlighted marks and the hit evidence list.
    expect(within(dialog).getAllByText('红色')).toHaveLength(2);
    expect(within(dialog).getAllByText('腺癌')).toHaveLength(3);
    expect(within(dialog).getByText('报告内容与诊断')).toBeInTheDocument();
    expect(within(dialog).getByText('…胃体见多发隆起型病变，考虑腺癌。…')).toBeInTheDocument();
    expect(within(dialog).getByText('规则 aaaaaaaa · v1')).toBeInTheDocument();
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
    expect(within(dialog).getByText('暂无命中记录')).toBeInTheDocument();
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
    expect(within(dialog).getByText('暂无命中记录')).toBeInTheDocument();
  });

  // Issue #87: a hit the AI judged not to express the rule's intent stays
  // visible (the keyword engine did fire) but is marked 未计入关注 and carries
  // the 上下文判读 line; it must NOT be highlighted as a reason for the visit.
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
    expect(dialog.querySelector('.drawer__hit-semantic-label')?.textContent).toBe('上下文判读');
  });

  it('does not invent a verdict for a hit that was never judged', async () => {
    render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '检查详情' });
    expect(within(dialog).queryByText('上下文判读')).not.toBeInTheDocument();
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

  describe('attentionSource badge', () => {
    it.each([
      ['RULE', '关键词'],
      ['AI_REPORT', 'AI 语义'],
      ['BOTH', '关键词 + AI 语义'],
    ] as const)('badges %s as 「%s」 next to the level tag', async (source, label) => {
      stubDetail(withAi({ attentionSource: source, aiSemantics: [], aiJudged: false }));
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      const line = dialog.querySelector('.drawer__level-line');
      const badge = line?.querySelector('.source-badge');
      expect(badge?.textContent).toBe(label);
      // The badge sits BESIDE the level tag, never replacing it, and it is
      // plain text: colour is not the only channel saying where the level came
      // from. (The hit row's own level tag is a separate element - hence the
      // scoping to the summary line.)
      expect(line?.querySelectorAll('.level-tag')).toHaveLength(1);
      expect(line?.querySelector('.level-tag')?.textContent).toBe('红色');
      expect(badge?.className).not.toMatch(/level-tag--/);
    });

    it('renders no badge at all when neither path found anything', async () => {
      stubDetail({
        ...detail,
        monitorLevel: 'UNCLASSIFIED',
        matchedKeywords: [],
        hits: [],
        attentionSource: 'NONE',
      });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(dialog.querySelector('.source-badge')).toBeNull();
      expect(within(dialog).getByText('未分级')).toBeInTheDocument();
    });
  });

  describe('AI 语义发现', () => {
    it('renders each finding with its level, name, confidence, reason and quotes', async () => {
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(within(dialog).getByRole('heading', { name: /AI 语义发现/ })).toBeInTheDocument();
      expect(within(dialog).getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
      expect(within(dialog).getByText('红色关注')).toBeInTheDocument();
      expect(within(dialog).getByText('把握高')).toBeInTheDocument();
      expect(within(dialog).getByText('报告描述了不规则隆起与质脆。')).toBeInTheDocument();

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
      // The AI quotes live in the AI section, never inside the report body.
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
      expect(within(dialog).getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
      expect(within(dialog).getByText('红色关注')).toBeInTheDocument();
      expect(within(dialog).getByText('把握高')).toBeInTheDocument();
      expect(dialog.querySelectorAll('blockquote.drawer__ai-evidence')).toHaveLength(0);
      expect(within(dialog).queryByText('报告描述了不规则隆起与质脆。')).not.toBeInTheDocument();
    });

    it('says so explicitly when the AI judged the report and found nothing', async () => {
      stubDetail({
        ...detail,
        attentionSource: 'RULE',
        aiJudged: true,
        aiSemantics: [],
      });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      expect(
        within(dialog).getByText('本次 AI 语义判读未发现需要关注的内容'),
      ).toBeInTheDocument();
    });

    it('says nothing about the AI when the report was never judged', async () => {
      stubDetail({ ...detail, aiJudged: false, aiSemantics: [] });
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // No claim either way: "we looked and found nothing" is a statement, and
      // the drawer must not make it when nobody looked.
      expect(within(dialog).queryByText(/AI 语义发现/)).not.toBeInTheDocument();
      expect(
        within(dialog).queryByText('本次 AI 语义判读未发现需要关注的内容'),
      ).not.toBeInTheDocument();
    });

    it('lists a RED finding above a GREEN one when both are present', async () => {
      stubDetail(
        withAi({
          aiSemantics: [
            aiFinding,
            {
              ...aiFinding,
              semanticId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              name: '值得记录的轻微表现',
              attentionLevel: 'GREEN',
              confidence: 'LOW',
              reason: null,
              evidence: [],
            },
          ],
        }),
      );
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      // The server sorts; the drawer renders in the order it was given, so this
      // asserts the rendering does not reorder behind the API's back.
      const items = dialog.querySelectorAll('li.drawer__ai-item');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain('明确或高度疑似恶性病变');
      expect(items[1].textContent).toContain('值得记录的轻微表现');
    });

    it('uses only doctor-facing wording, never the implementation vocabulary', async () => {
      stubDetail(withAi());
      render(<DetailDrawer recordId={detail.recordId} onClose={vi.fn()} />);

      const dialog = await screen.findByRole('dialog', { name: '检查详情' });
      const rendered = dialog.textContent ?? '';
      for (const leak of [
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
      ]) {
        expect(rendered).not.toContain(leak);
      }
      // Positive controls: the agreed wording really is on screen, so the scan
      // above cannot pass by rendering nothing.
      expect(rendered).toContain('AI 语义发现');
      expect(rendered).toContain('关注等级不是诊断结论');
      // Issue #87's line survives alongside it.
      expect(rendered).toContain('命中证据');
    });
  });
});
