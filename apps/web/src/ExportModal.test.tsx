import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportModal } from './ExportModal';

/**
 * 数据导出弹层（issue #139）。
 *
 * 这里不 mock `monitorApi` 而是替掉 `fetch`，让真实的 `downloadExamsCsv` 一起跑：
 * 请求参数、响应头解析（`X-Row-Count`）、错误信封分支、文件名双胞胎是否与后端一致，
 * 全都在同一条链上被验到。只 mock 掉 jsdom 没有的三件事：`URL.createObjectURL`、
 * `URL.revokeObjectURL`、以及 `<a>` 的 `click`（jsdom 会尝试真的导航）。
 *
 * 断的是五件事：
 *  1. 两个选择（一天 + 一个等级）真的发到了服务端；
 *  2. 有内容才落盘 —— 明确 0 行时不产生一个只有表头的文件；
 *  3. 读不到行数头时按「有内容」处理，不把正常文件当成空的丢掉；
 *  4. 403 显示的是服务端原话（「没有导出患者明细的权限…」）；
 *  5. 键盘与背景关闭，且开着时焦点在弹层上。
 */

const CSV_BODY = '﻿关注等级,患者姓名\r\n红色关注,测试患者甲\r\n';

/** 成功的 CSV 响应：有 blob 也有 X-Row-Count。 */
function csvResponse(text: string, rowCount: string | null = '1'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'X-Row-Count' ? rowCount : null) },
    blob: async () => new Blob([text], { type: 'text/csv;charset=utf-8' }),
    // 成功响应体不是 JSON —— 谁要是又用 parseResponse 读它，这里会直接炸
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
  } as unknown as Response;
}

/** 失败信封（服务端异常过滤器写的那种）。 */
function errorResponse(body: unknown, status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** 反代/网闸挡回来的一页 HTML：`.json()` 会抛。 */
function htmlResponse(status = 502): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('<!DOCTYPE html> is not valid JSON');
    },
  } as unknown as Response;
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickedAnchors: HTMLAnchorElement[];
let anchorClickSpy: ReturnType<typeof vi.spyOn>;

function installFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 弹层里那两条反馈条之一（成功提示 / 错误）。 */
async function submitExport(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '导出' })).not.toBeDisabled());
}

describe('ExportModal (issue #139)', () => {
  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:epgs-mock');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    clickedAnchors = [];
    anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    anchorClickSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('renders nothing while closed', () => {
    const { container } = render(<ExportModal open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the dialog exactly like the entry that opens it (issue #114)', () => {
    render(<ExportModal open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '数据导出' })).toBeInTheDocument();
  });

  it('offers one day and one level, defaulting to today and 红色关注', () => {
    render(<ExportModal open onClose={vi.fn()} />);

    const date = screen.getByLabelText('检查日期') as HTMLInputElement;
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    expect(date.value).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    );

    // 四个等级，文案来自全应用唯一那份映射（attentionSource.ts）
    const options = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(options.map((option) => option.value)).toEqual([
      'RED',
      'YELLOW',
      'GREEN',
      'UNCLASSIFIED',
    ]);
    expect(screen.getByLabelText('红色关注')).toBeChecked();
    // 没有「全部等级」这种选项 —— 暴露面控制的一部分，不是遗漏
    expect(screen.queryByLabelText('全部等级')).not.toBeInTheDocument();
  });

  it('sends the chosen day and level, then saves the file under the agreed name', async () => {
    const fetchMock = installFetch(csvResponse(CSV_BODY));
    render(<ExportModal open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('检查日期'), { target: { value: '2026-08-20' } });
    fireEvent.click(screen.getByLabelText('黄色关注'));
    await submitExport();

    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain('/api/monitor/export?');
    expect(requested).toContain('examDate=2026-08-20');
    expect(requested).toContain('level=YELLOW');
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ credentials: 'include' }));

    // 文件名与后端 monitor-csv.ts 的 csvFileName 是同一形状（双胞胎）
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].download).toBe('数据导出-2026-08-20-黄色关注.csv');
    expect(clickedAnchors[0].href).toBe('blob:epgs-mock');
    // 用完就撤销，不留一个悬着的 object URL
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:epgs-mock');

    expect(await screen.findByRole('status')).toHaveTextContent('已导出 1 条记录');
  });

  it('does not save a header-only file when the day has no matching rows', async () => {
    installFetch(csvResponse('﻿关注等级,患者姓名\r\n', '0'));
    render(<ExportModal open onClose={vi.fn()} />);

    await submitExport();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);
    expect(await screen.findByRole('status')).toHaveTextContent('当日没有符合条件的记录');
    // 不是错误：当天没有这个等级的患者是常态
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still saves when the row-count header is unreadable (null, not 0)', async () => {
    // 将来拆域后 X-Row-Count 没进 CORS exposedHeaders 时就是这个样子：
    // 把「读不到」当成 0 会把一个正常文件静默丢掉。
    installFetch(csvResponse(CSV_BODY, null));
    render(<ExportModal open onClose={vi.fn()} />);

    await submitExport();

    expect(clickedAnchors).toHaveLength(1);
    expect(await screen.findByRole('status')).toHaveTextContent('已开始下载');
  });

  it('shows the server wording for a 403 without the patientDetail grant', async () => {
    installFetch(
      errorResponse(
        {
          error: {
            code: 'PATIENT_DETAIL_REQUIRED',
            message: '没有导出患者明细的权限，请联系管理员开通。',
          },
        },
        403,
      ),
    );
    render(<ExportModal open onClose={vi.fn()} />);

    await submitExport();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '没有导出患者明细的权限，请联系管理员开通。',
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('asks for a fresh login on 401', async () => {
    const onAuthRequired = vi.fn();
    window.addEventListener('epgs:auth-required', onAuthRequired);
    installFetch(errorResponse({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401));
    render(<ExportModal open onClose={vi.fn()} />);

    await submitExport();

    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    window.removeEventListener('epgs:auth-required', onAuthRequired);
  });

  it('falls back to a readable message when the failure body is not JSON at all', async () => {
    // 反代/网闸挡在前面时回来的是一页 HTML；解析失败不能变成一个没有提示的死按钮
    installFetch(htmlResponse(502));
    render(<ExportModal open onClose={vi.fn()} />);

    await submitExport();

    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败，请稍后重试');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('disables 导出 while a date is missing', () => {
    render(<ExportModal open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('检查日期'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled();
  });

  it('closes on Escape, on the backdrop, on × and on 取消', () => {
    const onClose = vi.fn();
    const { container } = render(<ExportModal open onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = container.querySelector('.export-backdrop') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '关闭数据导出' }));
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('puts focus on the dialog when it opens, so the keyboard lands inside it', () => {
    render(<ExportModal open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});
