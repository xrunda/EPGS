import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MatchFieldDto, MonitorExamDetailDto, MonitorLevelDto } from '@epgs/shared-types';
import { getExamDetail, MonitorApiError } from './monitorApi';
import './DetailDrawer.css';

interface DetailDrawerProps {
  /** The monitor_record to load; null closes the drawer. */
  recordId: string | null;
  onClose: () => void;
}

const LEVEL_LABELS: Record<MonitorLevelDto, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  UNCLASSIFIED: '未分级',
};

/** Where the hit was found in the report (mirrors the issue #8 API doc mapping). */
const FIELD_LABELS: Record<MatchFieldDto, string> = {
  FINDINGS: '报告内容',
  IMPRESSION: '诊断',
  REPORT_TEXT: '报告内容与诊断',
  STUDY_DESCRIPTION: '检查项目',
  OTHER: '其他',
};

/** Fields whose hits are highlighted inside 报告内容. */
const REPORT_TEXT_FIELDS: MatchFieldDto[] = ['FINDINGS', 'REPORT_TEXT', 'OTHER'];

/** Fields whose hits are highlighted inside 诊断. */
const DIAGNOSIS_TEXT_FIELDS: MatchFieldDto[] = ['IMPRESSION', 'REPORT_TEXT', 'OTHER'];

/**
 * Splits `text` into React nodes, wrapping every case-insensitive occurrence of
 * any `keywords` in a <mark>. Overlapping matches are merged. The original text
 * is only sliced into nodes, never rewritten, so highlighting cannot corrupt it
 * (issue #10: "命中词高亮不修改报告原文").
 */
function highlightSegments(text: string, keywords: string[]): ReactNode[] {
  const lowered = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    let from = 0;
    let index = lowered.indexOf(lowerKeyword, from);
    while (index !== -1) {
      ranges.push([index, index + keyword.length]);
      from = index + keyword.length;
      index = lowered.indexOf(lowerKeyword, from);
    }
  }
  if (ranges.length === 0) return [text];

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark key={index} className="hit-highlight">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function friendlyError(error: unknown): string {
  if (error instanceof MonitorApiError && error.status === 404) {
    return '未找到该检查记录，可能已被移除。';
  }
  if (error instanceof MonitorApiError) return error.message;
  return '请求失败，请检查网络后重试。';
}

export function DetailDrawer({ recordId, onClose }: DetailDrawerProps): JSX.Element | null {
  const [detail, setDetail] = useState<MonitorExamDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);

  /** Distinct keywords to highlight inside 报告内容, from the hits that matched there. */
  const reportKeywords = useMemo(() => {
    if (!detail) return [];
    return Array.from(
      new Set(
        detail.hits
          .filter((hit) => REPORT_TEXT_FIELDS.includes(hit.matchedField))
          .map((hit) => hit.keyword),
      ),
    );
  }, [detail]);

  /** Distinct keywords to highlight inside 诊断, from the hits that matched there. */
  const diagnosisKeywords = useMemo(() => {
    if (!detail) return [];
    return Array.from(
      new Set(
        detail.hits
          .filter((hit) => DIAGNOSIS_TEXT_FIELDS.includes(hit.matchedField))
          .map((hit) => hit.keyword),
      ),
    );
  }, [detail]);

  useEffect(() => {
    if (!recordId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getExamDetail(recordId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((requestError) => {
        if (!cancelled) setError(friendlyError(requestError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recordId, reloadKey]);

  const requestClose = useCallback(() => {
    if (onClose) onClose();
  }, [onClose]);

  useEffect(() => {
    if (!recordId) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [recordId, requestClose]);

  // Move keyboard focus into the drawer when it opens so Escape is reachable;
  // the workbench restores focus to the triggering button on close.
  useEffect(() => {
    if (recordId) dialogRef.current?.focus();
  }, [recordId]);

  if (!recordId) return null;

  return (
    <aside className="drawer-backdrop" role="presentation" aria-label="检查详情抽屉">
      <section
        ref={dialogRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="检查详情"
        tabIndex={-1}
      >
        <header className="drawer__header">
          <div>
            <p className="drawer__eyebrow">内镜中心 · 只读详情</p>
            <h2>检查详情</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭检查详情"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="drawer-state">正在加载检查详情…</div>
        ) : error ? (
          <div className="drawer-state">
            <p>{error}</p>
            <button
              className="button"
              type="button"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              重新加载
            </button>
          </div>
        ) : detail ? (
          <div className="drawer__body">
            <div className="drawer__summary">
              <span className={`level-tag level-tag--${detail.monitorLevel.toLowerCase()}`}>
                {LEVEL_LABELS[detail.monitorLevel]}
              </span>
              <dl className="drawer__fields">
                <div>
                  <dt>姓名</dt>
                  <dd>{detail.patientName ?? '—'}</dd>
                </div>
                <div>
                  <dt>科室</dt>
                  <dd>{detail.department ?? '—'}</dd>
                </div>
                <div>
                  <dt>床号</dt>
                  <dd>{detail.bedNo ?? '—'}</dd>
                </div>
                <div>
                  <dt>患者类型</dt>
                  <dd>
                    {detail.patientType.name ?? detail.patientType.code ?? '—'}
                    {detail.patientType.name && detail.patientType.code
                      ? `（${detail.patientType.code}）`
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>检查项目</dt>
                  <dd>{detail.examItem ?? '—'}</dd>
                </div>
                <div>
                  <dt>检查日期</dt>
                  <dd>{detail.examDate ?? '—'}</dd>
                </div>
                <div>
                  <dt>检查时间</dt>
                  <dd>{detail.examTime ?? '—'}</dd>
                </div>
              </dl>
            </div>

            <section className="drawer__section">
              <h3>报告内容</h3>
              <p className="drawer__text">
                {detail.reportContent ? (
                  highlightSegments(detail.reportContent, reportKeywords)
                ) : (
                  <>
                    暂无报告内容
                    <span className="drawer__placeholder">（未同步到报告正文）</span>
                  </>
                )}
              </p>
            </section>

            <section className="drawer__section">
              <h3>诊断</h3>
              <p className="drawer__text">
                {detail.diagnosis ? (
                  highlightSegments(detail.diagnosis, diagnosisKeywords)
                ) : (
                  <>
                    暂无诊断
                    <span className="drawer__placeholder">（未同步到诊断意见）</span>
                  </>
                )}
              </p>
            </section>

            <section className="drawer__section">
              <h3>
                命中证据 <span className="drawer__count">{detail.hits.length}</span>
              </h3>
              {detail.hits.length === 0 ? (
                <p className="drawer__placeholder">暂无命中记录</p>
              ) : (
                <ul className="drawer__hits">
                  {detail.hits.map((hit) => (
                    <li
                      className="drawer__hit"
                      key={`${hit.ruleId}-${hit.matchedField}-${hit.keyword}`}
                    >
                      <div className="drawer__hit-head">
                        <span className={`level-tag level-tag--${hit.level.toLowerCase()}`}>
                          {LEVEL_LABELS[hit.level]}
                        </span>
                        <strong>{hit.keyword}</strong>
                        <span className="drawer__field-label">
                          {FIELD_LABELS[hit.matchedField]}
                        </span>
                      </div>
                      <blockquote className="drawer__snippet">{hit.contextSnippet}</blockquote>
                      <p className="drawer__hit-meta">
                        规则 {hit.ruleId.slice(0, 8)} · v{hit.ruleVersion}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
