import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorLevelDto } from '@epgs/shared-types';
import { ATTENTION_LEVEL_LABELS } from './attentionSource';
import { downloadExamsCsv, MonitorApiError } from './monitorApi';
import './ExportModal.css';

/**
 * 数据导出（issue #139）—— 按「一天 + 一个关注等级」把患者明细存成一个 CSV。
 *
 * 为什么只有这两个选项：文件离开系统之后就不受这里管了（会被打印、贴进 Excel、
 * 发到群里），所以暴露面必须由服务端的契约钉死，而不是靠界面上的组合去暗示。
 * 单日 + 单等级意味着不存在「把一天的全部患者打成一个文件」这条路径，也没有
 * 「导出当前筛选」——那会让文件内容与弹层上看得见的两个选择不一致。
 *
 * 权限：入口本身只在有 `patientDetail` 授权时出现（Workbench / App.tsx），这里
 * 再对 403 显示服务端原话。前端两道都只是「别让人白点」，真正的闸门在服务端。
 *
 * 0 行不落盘：一个只有表头的文件对用户没有任何用，却会被当成「导出成功」存进
 * 下载目录，然后被转发出去。所以这里是明确的一句「当日没有符合条件的记录」。
 */

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

/** 四个等级，顺序与配置页、列表标签一致（红 → 黄 → 绿 → 未分级）。 */
const LEVEL_ORDER: MonitorLevelDto[] = ['RED', 'YELLOW', 'GREEN', 'UNCLASSIFIED'];

/** 默认导出今天。用本地日期而不是 UTC：弹层上的日期就是操作者理解的「今天」。 */
function todayLocalDate(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function friendlyError(error: unknown): string {
  if (error instanceof MonitorApiError) {
    // 服务端已经把「没有患者明细授权」写成了人话（PATIENT_DETAIL_REQUIRED），
    // 直接用它；其余情况也给一句能照着做的。
    return error.message;
  }
  return '导出失败，请检查网络后重试。';
}

export function ExportModal({ open, onClose }: ExportModalProps): JSX.Element | null {
  const [examDate, setExamDate] = useState(todayLocalDate);
  const [level, setLevel] = useState<MonitorLevelDto>('RED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const requestClose = useCallback(() => {
    setError(null);
    setNotice(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose]);

  if (!open) return null;

  async function runExport(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await downloadExamsCsv({ examDate, level });
      if (result.rowCount === 0) {
        // 明确知道是空的：不产出一个只有表头的文件。rowCount 为 null（头读不到）
        // 时按有内容处理 —— 宁可让用户拿到文件，也不能把正常结果静默丢掉。
        setNotice('当日没有符合条件的记录');
        return;
      }
      const url = URL.createObjectURL(result.blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setNotice(
        result.rowCount === null
          ? '已开始下载'
          : `已导出 ${result.rowCount} 条记录，请查看下载文件`,
      );
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="export-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
      >
        <header className="export-modal__header">
          <div>
            <p className="export-modal__eyebrow">内镜中心 · 数据导出</p>
            <h2 id="export-title">数据导出</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭数据导出"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        <div className="export-modal__notice">
          <span aria-hidden="true">i</span>
          <p>
            导出的是<b>一天、一个关注等级</b>的患者明细，文件为 CSV，可用 Excel 直接打开。文件里含
            <b>患者姓名与手机号</b>，请按院内规定保管，不要转发到无关的群。
          </p>
          <p>未审核报告仅用于监测，不作为正式诊断依据；导出的内容与此一致。</p>
        </div>

        <form
          className="export-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runExport();
          }}
        >
          <label className="export-form__date">
            检查日期
            <input
              type="date"
              value={examDate}
              onChange={(event) => setExamDate(event.target.value)}
              required
            />
          </label>

          <fieldset className="export-form__levels">
            <legend>关注等级</legend>
            {LEVEL_ORDER.map((option) => (
              <label key={option} className={`export-level export-level--${option.toLowerCase()}`}>
                <input
                  type="radio"
                  name="export-level"
                  value={option}
                  checked={level === option}
                  onChange={() => setLevel(option)}
                />
                <span>{ATTENTION_LEVEL_LABELS[option]}</span>
              </label>
            ))}
          </fieldset>

          {error && (
            <div className="feedback feedback--error" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)}>
                关闭
              </button>
            </div>
          )}
          {notice && (
            <div className="feedback feedback--success" role="status">
              {notice}
            </div>
          )}

          <div className="export-form__actions">
            <button className="button" type="button" onClick={requestClose}>
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={busy || !examDate}>
              {busy ? '正在导出…' : '导出'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
