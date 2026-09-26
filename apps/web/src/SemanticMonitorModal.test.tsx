import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AttentionSemanticDto, AttentionLevelDto } from '@epgs/shared-types';
import { SemanticMonitorModal } from './SemanticMonitorModal';

/**
 * AI 语义监控弹窗（issue #88）。
 *
 * 这里断的是三件事：
 *  1. 医生能看到并改到的东西 —— 三色池、语义列表、新增/编辑/启停；
 *  2. 文案守则 —— 页面上只有「关注语义」「关注等级」这类说法，不出现 Prompt /
 *     提示词 / 大模型 / 分类器 这些实现词汇，且「仅用于监测，不作为正式诊断」
 *     常驻；
 *  3. 两个必须走服务端的约定 —— 改语义文字要带上 version（乐观锁），预置语义
 *     只能由人点按钮载入，且默认不覆盖同名条目。
 */

const redSemantic: AttentionSemanticDto = {
  id: '11111111-1111-4111-8111-111111111111',
  semanticGroupId: '11111111-1111-4111-8111-111111111111',
  name: '明确或高度疑似恶性病变',
  description: '报告描述了提示恶性或高度可疑恶性的表现，例如不规则隆起、质脆易出血。',
  attentionLevel: 'RED',
  isEnabled: true,
  version: 1,
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  createdBy: 'zhang.san',
  updatedBy: 'zhang.san',
};

const yellowSemantic: AttentionSemanticDto = {
  ...redSemantic,
  id: '22222222-2222-4222-8222-222222222222',
  semanticGroupId: '22222222-2222-4222-8222-222222222222',
  name: '性质待定、需活检的病变',
  description: '报告提示性质待定，需要活检或短期复查。',
  attentionLevel: 'YELLOW',
  isEnabled: false,
  version: 3,
};

/** 三色池概览的三个计数查询各自的返回值。 */
const POOL_TOTALS: Record<AttentionLevelDto, number> = { RED: 2, YELLOW: 1, GREEN: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/**
 * 安装 fetch 替身。列表查询与三色池计数查询共用同一个 GET 端点，用 pageSize
 * 区分：计数查询固定 pageSize=1。
 */
function installFetch(
  overrides: {
    items?: AttentionSemanticDto[];
    listError?: Response;
    writeError?: Response;
    importResult?: Record<string, unknown>;
  } = {},
): void {
  const items = overrides.items ?? [redSemantic, yellowSemantic];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' || init?.method === 'PUT') {
        if (overrides.writeError) return overrides.writeError;
        if (url.includes('/import-defaults')) {
          return jsonResponse(
            overrides.importResult ?? {
              createdCount: 6,
              skippedCount: 0,
              updatedCount: 0,
              semanticIds: ['a', 'b', 'c', 'd', 'e', 'f'],
            },
            201,
          );
        }
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(
          { ...redSemantic, ...payload, id: 'new-semantic-id', version: 2 },
          init.method === 'POST' ? 201 : 200,
        );
      }
      if (overrides.listError) return overrides.listError;
      if (url.includes('pageSize=1')) {
        const level = new URL(url, 'http://localhost').searchParams.get(
          'attentionLevel',
        ) as AttentionLevelDto;
        return jsonResponse({ items: [], total: POOL_TOTALS[level], page: 1, pageSize: 1 });
      }
      return jsonResponse({ items, total: items.length, page: 1, pageSize: 20 });
    }),
  );
}

/** 触发查询/保存等操作后，读取那次写入请求的 body。 */
function writeBody(method: 'POST' | 'PUT'): Record<string, unknown> {
  const call = vi.mocked(fetch).mock.calls.find(([input, init]) => {
    if (init?.method !== method) return false;
    // 载入预置语义也是 POST，这里只关心语义本身的写入。
    return !String(input).includes('/import-defaults');
  });
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

describe('SemanticMonitorModal', () => {
  beforeEach(() => {
    installFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists the configured semantics with colour and status', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);

    expect(screen.getByText('正在加载关注语义…')).toBeInTheDocument();
    await screen.findByText('明确或高度疑似恶性病变');

    const redRow = screen.getByRole('row', { name: /明确或高度疑似恶性病变/ });
    // 等级文字必须带「关注」二字（Issue #88 定稿文案）：RED / YELLOW / GREEN 是
    // 管理上的「关注等级」，不是病情严重程度。
    expect(within(redRow).getByText('红色关注')).toBeInTheDocument();
    expect(within(redRow).getByText('启用')).toBeInTheDocument();
    expect(within(redRow).getByText('v1')).toBeInTheDocument();

    // A disabled entry stays visible (it is a version history, not a deletion)
    // and is distinguishable from an enabled one.
    const yellowRow = screen.getByRole('row', { name: /性质待定、需活检的病变/ });
    expect(within(yellowRow).getByText('黄色关注')).toBeInTheDocument();
    expect(within(yellowRow).getByText('停用')).toBeInTheDocument();
    expect(within(yellowRow).getByText('v3')).toBeInTheDocument();
  });

  // Issue #88 定稿文案：入口叫「AI 语义监控」，一条配置叫「关注语义」，等级叫
  // 「关注等级」；页面上不得出现 Prompt / 提示词 / 大模型 / 分类器 这类实现词汇，
  // 且「仅用于监测，不作为正式诊断」必须常驻。
  it('presents the agreed wording and never the implementation vocabulary', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    expect(screen.getByRole('heading', { name: 'AI 语义监控' })).toBeInTheDocument();
    expect(screen.getByText('理解医生这句话真正表达了什么意思。')).toBeInTheDocument();
    expect(screen.getByText('关键词监控看「字」 · AI 语义监控看「意思」')).toBeInTheDocument();
    expect(screen.getByText(/不作为正式诊断/)).toBeInTheDocument();
    expect(screen.getByText(/不是诊断结论，也不代表病情严重程度/)).toBeInTheDocument();

    for (const leak of ['Prompt', '提示词', '大模型', 'LLM', 'Classifier', '分类器', 'JSON', '模型']) {
      expect(screen.queryByText(new RegExp(leak, 'i'))).not.toBeInTheDocument();
    }
  });

  // Issue #88 定稿文案的机械守门：这一页任何一处等级文字都不能只写颜色。
  // 上一轮就是因为在四个地方各写了一份字面量，才漏掉了表格行、表单卡片和筛选下拉
  // 三处；现在四处共用一个映射，这条扫描保证不会再漏。
  it('never prints a colour without 「关注」 - on the page or in the form', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('明确或高度疑似恶性病变');

    const bareColour = /(?:红色|黄色|绿色)(?!关注)/;
    expect(document.body.textContent ?? '').not.toMatch(bareColour);

    // The form's level cards and the filter dropdown are the two places a bare
    // colour used to hide, so the scan has to run with both on screen.
    fireEvent.click(screen.getByRole('button', { name: '新增关注语义' }));
    expect(screen.getByRole('radio', { name: /红色关注/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /黄色关注/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /绿色关注/ })).toBeInTheDocument();
    // The level filter's own options (the status filter's are not colours).
    const levelOptions = Array.from(document.querySelectorAll('option')).map(
      (option) => option.textContent ?? '',
    );
    expect(levelOptions).toEqual(
      expect.arrayContaining(['红色关注', '黄色关注', '绿色关注']),
    );
    for (const option of levelOptions) {
      expect(option).not.toMatch(bareColour);
    }
    expect(document.body.textContent ?? '').not.toMatch(bareColour);
  });

  it('summarises the three-colour pool over ENABLED semantics only', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    const pool = await screen.findByLabelText('三色关注池');
    // 2 + 1 + 0 — the counts come from the server, so a page of 20 cannot
    // misreport how many meanings are actually in force.
    expect(within(pool).getByText('3 条')).toBeInTheDocument();
    expect(within(pool).getByText('需要尽快人工确认')).toBeInTheDocument();
    expect(within(pool).getByText('需要留意或安排跟进')).toBeInTheDocument();
    expect(within(pool).getByText('值得记录，暂不需要处理')).toBeInTheDocument();

    // 池标题必须带「关注」二字：RED / YELLOW / GREEN 是「关注等级」（要多久看到），
    // 不是病情严重程度，光写颜色会被医生读成轻重分级。
    for (const label of ['红色关注', '黄色关注', '绿色关注']) {
      expect(within(pool).getByText(label)).toBeInTheDocument();
    }

    const countCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes('pageSize=1'));
    expect(countCalls).toHaveLength(3);
    for (const [input] of countCalls) {
      // A disabled semantic is not judging anything, so it must not be counted
      // into a pool an operator reads as "what is currently watching reports".
      expect(String(input)).toContain('isEnabled=true');
    }
  });

  it('queries by name, colour and status', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '恶性' } });
    fireEvent.change(screen.getByLabelText('关注等级'), { target: { value: 'RED' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('name=%E6%81%B6%E6%80%A7'))).toBe(true);
    });
    const listUrl = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((url) => url.includes('pageSize=20'))
      .pop();
    expect(listUrl).toContain('attentionLevel=RED');
    expect(listUrl).toContain('isEnabled=true');
  });

  it('creates a semantic with the colour the doctor picked', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.click(screen.getByRole('button', { name: '新增关注语义' }));
    fireEvent.change(screen.getByLabelText('关注语义名称'), { target: { value: '活动性出血' } });
    fireEvent.change(screen.getByLabelText('这类情况是什么样的（说明）'), {
      target: { value: '报告描述了活动性出血或近期出血征象。' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /红色/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('关注语义已新增')).toBeInTheDocument();
    expect(writeBody('POST')).toMatchObject({
      name: '活动性出血',
      description: '报告描述了活动性出血或近期出血征象。',
      attentionLevel: 'RED',
      isEnabled: true,
      actorId: 'rule-admin',
    });
  });

  it('refuses to save without saying what the semantic means', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.click(screen.getByRole('button', { name: '新增关注语义' }));
    fireEvent.change(screen.getByLabelText('关注语义名称'), { target: { value: '活动性出血' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // The description is what the classifier reads, so an empty one is a
    // configuration mistake rather than a cosmetic omission.
    expect(
      await screen.findByText('请说明这条关注语义要关注报告里的什么情况。'),
    ).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('sends the current version when editing, and says the change is versioned', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    const row = screen.getByRole('row', { name: /明确或高度疑似恶性病变/ });
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('这类情况是什么样的（说明）'), {
      target: { value: '改写后的说明文字。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/历史判定仍指向修改前的文字/)).toBeInTheDocument();
    expect(writeBody('PUT')).toMatchObject({ version: 1, description: '改写后的说明文字。' });
  });

  it('enables and disables a semantic with its current version', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    const row = screen.getByRole('row', { name: /性质待定、需活检的病变/ });
    fireEvent.click(within(row).getByRole('button', { name: /启用“性质待定、需活检的病变”/ }));

    expect(await screen.findByText('已启用')).toBeInTheDocument();
    expect(writeBody('PUT')).toMatchObject({ isEnabled: true, version: 3 });
  });

  it('tells the operator to reload when someone else already changed the semantic', async () => {
    installFetch({
      writeError: errorResponse(
        'ATTENTION_SEMANTIC_VERSION_CONFLICT',
        'Attention semantic was modified by another operator',
        409,
      ),
    });
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    const row = screen.getByRole('row', { name: /明确或高度疑似恶性病变/ });
    fireEvent.click(
      within(row).getByRole('button', { name: /停用“明确或高度疑似恶性病变”/ }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/已被其他人修改，请刷新后重试/);
  });

  it('explains a duplicate name instead of showing the server message', async () => {
    installFetch({
      writeError: errorResponse(
        'ATTENTION_SEMANTIC_CONFLICT',
        'An enabled attention semantic with the same name already exists.',
        409,
      ),
    });
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.click(screen.getByRole('button', { name: '新增关注语义' }));
    fireEvent.change(screen.getByLabelText('关注语义名称'), { target: { value: '活动性出血' } });
    fireEvent.change(screen.getByLabelText('这类情况是什么样的（说明）'), {
      target: { value: '报告描述了活动性出血或近期出血征象。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/已有同名的启用语义/);
  });

  it('loads the presets only after the operator confirms, and does not overwrite by default', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.click(screen.getByRole('button', { name: '载入预置语义' }));
    const panel = screen.getByLabelText('载入预置语义');
    expect(within(panel).getByText(/不是任何学会或医院的标准/)).toBeInTheDocument();
    // Nothing has been written yet: opening the panel is not loading.
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(within(panel).getByRole('button', { name: '确认载入' }));

    expect(await screen.findByText(/已载入 6 条预置语义/)).toBeInTheDocument();
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).includes('/import-defaults'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      overwriteExisting: false,
      actorId: 'rule-admin',
    });
  });

  it('only overwrites existing entries when the operator has opted in', async () => {
    installFetch({
      importResult: { createdCount: 0, skippedCount: 5, updatedCount: 1, semanticIds: ['x'] },
    });
    render(<SemanticMonitorModal open onClose={vi.fn()} />);
    await screen.findByText('明确或高度疑似恶性病变');

    fireEvent.click(screen.getByRole('button', { name: '载入预置语义' }));
    const panel = screen.getByLabelText('载入预置语义');
    fireEvent.click(within(panel).getByLabelText(/用模板覆盖同名语义/));
    fireEvent.click(within(panel).getByRole('button', { name: '确认载入' }));

    expect(await screen.findByText(/跳过 5 条已存在的，覆盖 1 条/)).toBeInTheDocument();
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).includes('/import-defaults'));
    expect(JSON.parse(String(call?.[1]?.body)).overwriteExisting).toBe(true);
  });

  it('shows the configuration read-only to an operator who may not change it', async () => {
    render(<SemanticMonitorModal open onClose={vi.fn()} canManageAiSemantics={false} />);
    await screen.findByText('明确或高度疑似恶性病变');

    // Reads still work - a doctor needs to see what the hospital is watching.
    expect(screen.getByText('明确或高度疑似恶性病变')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增关注语义' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '载入预置语义' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停用' })).not.toBeInTheDocument();
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  });

  it('keeps the table usable when the pool counts cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes('pageSize=1')) {
          return errorResponse('INTERNAL_ERROR', 'boom', 500);
        }
        return jsonResponse({ items: [redSemantic], total: 1, page: 1, pageSize: 20 });
      }),
    );

    render(<SemanticMonitorModal open onClose={vi.fn()} />);

    // The overview is an extra; losing it must not replace a working page.
    expect(await screen.findByText('明确或高度疑似恶性病变')).toBeInTheDocument();
    expect(screen.queryByText('需要尽快人工确认')).not.toBeInTheDocument();
    expect(screen.queryByText('当前生效')).not.toBeInTheDocument();
  });

  it('explains the empty state and that nothing changes without configuration', async () => {
    installFetch({ items: [] });
    render(<SemanticMonitorModal open onClose={vi.fn()} />);

    expect(await screen.findByText('还没有配置任何关注语义')).toBeInTheDocument();
    // The promise an operator needs most: leaving this page empty is safe.
    expect(screen.getByText(/行为与以前完全一致/)).toBeInTheDocument();
  });
});
