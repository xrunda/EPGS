import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorLevelDto } from '@epgs/shared-types';
import { ATTENTION_LEVEL_LABELS, ATTENTION_LEVEL_ORDER } from './attentionSource';
import { downloadExamsCsv, MonitorApiError } from './monitorApi';
import './ExportModal.css';

/**
 * 数据导出（issue #139）—— 按「一天 + 选定的关注等级」把患者明细存成一个 CSV。
 *
 * 为什么只有这两个选项：文件离开系统之后就不受这里管了（会被打印、贴进 Excel、
 * 发到群里），所以暴露面必须由服务端的契约钉死，而不是靠界面上的组合去暗示。
 * 没有「导出当前筛选」——那会让文件内容与弹层上看得见的选择不一致。
 *
 * issue #145 把等级从单选改成多选：一天里常要同时拿走红+黄。代价是「把一天的全部
 * 患者打成一个文件」这条路径变成可达成（勾满四个等级），所以服务端的 10 000 行上限
 * 从「永不触发的护栏」变成可能真的挡住一次请求 —— 它返回 400，**不截断**。
 * 一个都不选时导出按钮禁用（不阻止取消勾选：勾选框的语义不能骗人）。
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

/** 默认导出今天。用本地日期而不是 UTC：弹层上的日期就是操作者理解的「今天」。 */
function todayLocalDate(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 勾选框的开关。规范化交给发送方（monitorApi 会去重并排好序），这里保持用户点击的
 * 顺序，只保证同一个等级不会出现两次。
 */
function toggleLevel(current: MonitorLevelDto[], option: MonitorLevelDto): MonitorLevelDto[] {
  return current.includes(option)
    ? current.filter((level) => level !== option)
    : [...current, option];
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
  // 默认勾红色：与 #145 之前那次单选的默认一致，最常用的一档。
  const [levels, setLevels] = useState<MonitorLevelDto[]>(['RED']);
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
      const result = await downloadExamsCsv({ examDate, levels });
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
            导出的是<b>一天、选定的关注等级</b>（可多选）的患者明细，文件为 CSV，可用 Excel
            直接打开。文件里含
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
            {ATTENTION_LEVEL_ORDER.map((option) => (
              <label key={option} className={`export-level export-level--${option.toLowerCase()}`}>
                <input
                  type="checkbox"
                  name="export-level"
                  value={option}
                  checked={levels.includes(option)}
                  onChange={() => setLevels((current) => toggleLevel(current, option))}
                />
                <span>{ATTENTION_LEVEL_LABELS[option]}</span>
              </label>
            ))}
          </fieldset>
          {/* 一个都不选时导出按钮会禁用；不说一句就等于给了一个点了没反应的按钮。 */}
          {levels.length === 0 && (
            <p className="export-form__hint" role="status">
              至少选择一个关注等级才能导出。
            </p>
          )}

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
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || !examDate || levels.length === 0}
            >
              {busy ? '正在导出…' : '导出'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
