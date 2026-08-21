import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitorRuleDto } from '@epgs/shared-types';
import { RulesModal } from './RulesModal';

const redRule: MonitorRuleDto = {
  id: '11111111-1111-4111-8111-111111111111',
  keyword: '癌',
  level: 'RED',
  matchField: 'REPORT_TEXT',
  matchMode: 'CONTAINS',
  category: null,
  isEnabled: true,
  version: 1,
  ruleGroupId: '11111111-1111-4111-8111-111111111111',
  notes: '初始红色关键词',
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  createdBy: 'system-seed',
  updatedBy: 'system-seed',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('RulesModal', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/import/validate')) {
          return jsonResponse({
            importToken: 'import-token',
            totalRows: 2,
            validRows: 1,
            errors: [{ line: 3, message: 'level "BLUE" is invalid' }],
            preview: [
              {
                line: 2,
                keyword: '肿瘤',
                level: 'RED',
                matchField: 'REPORT_TEXT',
                matchMode: 'CONTAINS',
              },
            ],
          });
        }
        if (url.includes('/import/confirm')) {
          return jsonResponse({ createdCount: 1, createdRuleIds: ['new-rule-id'] });
        }
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse(
            {
              ...redRule,
              id: '22222222-2222-4222-8222-222222222222',
              ruleGroupId: '22222222-2222-4222-8222-222222222222',
              keyword: payload.keyword,
              level: payload.level,
              matchField: payload.matchField,
              matchMode: payload.matchMode,
              notes: payload.notes,
              isEnabled: payload.isEnabled,
            },
            201,
          );
        }
        if (init?.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ ...redRule, ...payload, version: redRule.version + 1 });
        }
        return jsonResponse({ items: [redRule], total: 1, page: 1, pageSize: 20 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and displays configured rules with attention-level wording', async () => {
    render(<RulesModal open onClose={vi.fn()} />);

    expect(screen.getByText('正在加载监测规则…')).toBeInTheDocument();
    expect(await screen.findByText('癌')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /癌/ });
    expect(within(row).getByText('红色')).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
    expect(screen.getByText('规则修改仅影响后续新数据，不自动重算历史数据。')).toBeInTheDocument();
  });

  it('queries by keyword, attention level, and status', async () => {
    render(<RulesModal open onClose={vi.fn()} />);
    await screen.findByText('癌');

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '肿瘤' } });
    fireEvent.change(screen.getByLabelText('关注等级'), { target: { value: 'RED' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
      expect(
        calls.some(
          (url) =>
            url.includes('keyword=%E8%82%BF%E7%98%A4') &&
            url.includes('level=RED') &&
            url.includes('isEnabled=true'),
        ),
      ).toBe(true);
    });
  });

  it('moves through API pages without loading an unbounded rule list', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const page = url.includes('page=2') ? 2 : 1;
      return jsonResponse({ items: [redRule], total: 25, page, pageSize: 20 });
    });
    render(<RulesModal open onClose={vi.fn()} />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('page=2'))).toBe(
        true,
      );
    });
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument();
  });

  it('creates a rule and adds the confirmed server result to the table', async () => {
    render(<RulesModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '新增规则' }));
    fireEvent.change(screen.getByLabelText('规则关键词'), { target: { value: '食管裂孔疝' } });
    fireEvent.change(screen.getByLabelText('规则关注等级'), { target: { value: 'RED' } });
    fireEvent.change(screen.getByLabelText('匹配范围'), { target: { value: 'REPORT_TEXT' } });
    fireEvent.change(screen.getByLabelText('匹配方式'), { target: { value: 'CONTAINS' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '内镜中心确认' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    expect(await screen.findByText('规则已新增')).toBeInTheDocument();
    expect(screen.getByText('食管裂孔疝')).toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      keyword: '食管裂孔疝',
      level: 'RED',
      matchField: 'REPORT_TEXT',
      matchMode: 'CONTAINS',
      actorId: 'rule-admin',
    });
  });

  it('edits a rule with its current optimistic-lock version', async () => {
    render(<RulesModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByLabelText('规则关键词')).toHaveValue('癌');
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '调整后的备注' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));

    expect(await screen.findByText('规则已保存')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      notes: '调整后的备注',
      version: 1,
      actorId: 'rule-admin',
    });
  });

  it('shows actionable duplicate and concurrent-edit errors', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: { code: 'RULE_CONFLICT', message: 'duplicate' } }, 409);
      }
      if (init?.method === 'PUT') {
        return jsonResponse({ error: { code: 'RULE_VERSION_CONFLICT', message: 'stale' } }, 409);
      }
      return jsonResponse({ items: [redRule], total: 1, page: 1, pageSize: 20 });
    });
    render(<RulesModal open onClose={vi.fn()} />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '新增规则' }));
    fireEvent.change(screen.getByLabelText('规则关键词'), { target: { value: '癌' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    expect(
      await screen.findByText('存在重复或冲突规则，请调整关键词或匹配条件。'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '并发修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }));
    expect(await screen.findByText('规则已被其他人修改，请刷新后重试。')).toBeInTheDocument();
  });

  it('uses optimistic locking when disabling a rule', async () => {
    render(<RulesModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '停用“癌”' }));

    expect(await screen.findByText('规则已停用')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      isEnabled: false,
      version: 1,
      actorId: 'rule-admin',
    });
  });

  it('validates a CSV, shows row errors, and confirms valid rows', async () => {
    render(<RulesModal open onClose={vi.fn()} actorId="rule-admin" />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '批量导入' }));
    const file = new File(['keyword,level,matchField\n肿瘤,RED,REPORT_TEXT'], 'rules.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText(/选择 CSV 文件/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '预校验' }));

    expect(await screen.findByText('1 条可导入，1 条错误')).toBeInTheDocument();
    expect(screen.getByText(/第 3 行/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入 1 条' }));
    expect(await screen.findByText('已成功导入 1 条规则')).toBeInTheDocument();
  });

  it('protects unsaved edits and provides a read-only mode', async () => {
    const onClose = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { rerender } = render(<RulesModal open onClose={onClose} />);
    await screen.findByText('癌');

    fireEvent.click(screen.getByRole('button', { name: '新增规则' }));
    fireEvent.change(screen.getByLabelText('规则关键词'), { target: { value: '肿物' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭监测规则配置' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    rerender(<RulesModal open onClose={onClose} canManageRules={false} />);
    expect(screen.queryByRole('button', { name: '新增规则' })).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: /癌/ });
    expect(within(row).getByText('只读')).toBeInTheDocument();
  });

  it('moves keyboard focus into the dialog and supports Escape to close', async () => {
    const onClose = vi.fn();
    render(<RulesModal open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '监测规则配置' });
    expect(dialog).toHaveFocus();
    await screen.findByText('癌');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
