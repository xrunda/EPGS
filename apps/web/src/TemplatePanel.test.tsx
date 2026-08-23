import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NotificationTemplateDto } from '@epgs/shared-types';
import { TemplatePanel } from './TemplatePanel';

const template: NotificationTemplateDto = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: '红色关注提醒',
  msgType: 'TEXT',
  titleTemplate: null,
  contentTemplate: '{{redCount}} 例红色关注患者',
  coverImageUrl: null,
  linkUrl: null,
  isEnabled: true,
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  createdBy: 'admin',
  updatedBy: 'admin',
};

const VARIABLES = [
  { key: 'redCount', label: '红色关注数量', example: '3' },
  { key: 'examDate', label: '检查日期', example: '2026-08-20' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPanel(
  overrides: Partial<{
    canManageNotifications: boolean;
    onOpenTestSend: (preselected: { templateId: string }) => void;
  }> = {},
) {
  return render(
    <TemplatePanel
      actorId="notify-admin"
      canManageNotifications={overrides.canManageNotifications ?? true}
      onDirtyChange={vi.fn()}
      onOpenTestSend={overrides.onOpenTestSend ?? vi.fn()}
    />,
  );
}

function newTemplateEditor() {
  return within(screen.getByRole('complementary', { name: '新增模板表单' }));
}

describe('TemplatePanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/variables')) {
          return jsonResponse(VARIABLES);
        }
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse(
            {
              ...template,
              id: 'new-template-id',
              name: payload.name,
              msgType: payload.msgType,
              titleTemplate: payload.titleTemplate ?? null,
            },
            201,
          );
        }
        if (init?.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({ ...template, ...payload });
        }
        return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 20 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and displays templates with type and status', async () => {
    renderPanel();

    expect(screen.getByText('正在加载模板…')).toBeInTheDocument();
    expect(await screen.findByText('红色关注提醒')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /红色关注提醒/ });
    expect(within(row).getByText('文本（TEXT）')).toBeInTheDocument();
    expect(within(row).getByText('启用')).toBeInTheDocument();
  });

  it('filters by message type and status in the query string', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.change(screen.getByLabelText('消息类型'), { target: { value: 'TEXT' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(
          ([url]) =>
            String(url).includes('msgType=TEXT') && String(url).includes('isEnabled=true'),
        ),
      ).toBe(true);
    });
  });

  it('creates a TEXT template without title or link fields', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '新增模板' }));
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '文本值班提醒' } });
    fireEvent.change(screen.getByLabelText('消息正文模板'), { target: { value: '今晚值班：{{name}}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    expect(await screen.findByText('模板已新增')).toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: '文本值班提醒',
      msgType: 'TEXT',
      contentTemplate: '今晚值班：{{name}}',
      actorId: 'notify-admin',
    });
    expect(body).not.toHaveProperty('titleTemplate');
    expect(body).not.toHaveProperty('coverImageUrl');
    expect(body).not.toHaveProperty('linkUrl');
  });

  it('offers only TEXT in the editor and marks NEWS as pending', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '新增模板' }));
    const typeSelect = newTemplateEditor().getByLabelText('消息类型') as HTMLSelectElement;
    const textOption = within(typeSelect).getByRole('option', {
      name: '文本（TEXT）',
    }) as HTMLOptionElement;
    const newsOption = within(typeSelect).getByRole('option', {
      name: '图文（NEWS）· 待开发',
    }) as HTMLOptionElement;
    expect(textOption.disabled).toBe(false);
    expect(newsOption.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '文本值班提醒' } });
    fireEvent.change(screen.getByLabelText('消息正文模板'), { target: { value: '今晚值班：{{name}}' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    expect(await screen.findByText('模板已新增')).toBeInTheDocument();
    const postCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: '文本值班提醒',
      msgType: 'TEXT',
      contentTemplate: '今晚值班：{{name}}',
      actorId: 'notify-admin',
    });
    expect(body).not.toHaveProperty('titleTemplate');
    expect(body).not.toHaveProperty('coverImageUrl');
    expect(body).not.toHaveProperty('linkUrl');
  });

  it('edits a TEXT template and submits a body without title or link fields', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByLabelText('模板名称')).toHaveValue('红色关注提醒');
    // NEWS 字段已隐藏（待开发），编辑表单只有文本字段
    expect(screen.queryByLabelText('消息标题')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('消息正文模板'), { target: { value: '更新后的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));

    expect(await screen.findByText('模板已保存')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    const body = JSON.parse(String(putCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: '红色关注提醒',
      msgType: 'TEXT',
      contentTemplate: '更新后的正文',
      actorId: 'notify-admin',
    });
    expect(body).not.toHaveProperty('titleTemplate');
    expect(body).not.toHaveProperty('coverImageUrl');
    expect(body).not.toHaveProperty('linkUrl');
  });

  it('inserts a variable token at the cursor using only server-provided options', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByLabelText('消息正文模板') as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const picker = screen.getByLabelText('插入变量');
    expect(within(picker).getByText('红色关注数量（{{redCount}}）')).toBeInTheDocument();
    expect(within(picker).getByText('检查日期（{{examDate}}）')).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'redCount' } });

    expect(textarea.value).toBe('{{redCount}} 例红色关注患者{{redCount}}');
  });

  it('toggles a template without an optimistic-lock version', async () => {
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '停用“红色关注提醒”' }));

    expect(await screen.findByText('模板已停用')).toBeInTheDocument();
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      isEnabled: false,
      actorId: 'notify-admin',
    });
  });

  it('maps the server title-required code to a friendly message', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/variables')) return jsonResponse(VARIABLES);
      if (init?.method === 'PUT') {
        return jsonResponse(
          { error: { code: 'NOTIFICATION_TEMPLATE_TITLE_REQUIRED', message: 'title' } },
          400,
        );
      }
      return jsonResponse({ items: [template], total: 1, page: 1, pageSize: 20 });
    });
    renderPanel();
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '停用“红色关注提醒”' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'NEWS 类型模板必须填写标题。',
    );
  });

  it('opens the test-send dialog preselected with the template', async () => {
    const onOpenTestSend = vi.fn();
    renderPanel({ onOpenTestSend });
    await screen.findByText('红色关注提醒');

    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));

    expect(onOpenTestSend).toHaveBeenCalledWith({ templateId: template.id });
  });

  it('hides all write actions in read-only mode', async () => {
    renderPanel({ canManageNotifications: false });
    await screen.findByText('红色关注提醒');

    expect(screen.queryByRole('button', { name: '新增模板' })).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: /红色关注提醒/ });
    expect(within(row).getByText('只读')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '发送测试' })).not.toBeInTheDocument();
  });
});
