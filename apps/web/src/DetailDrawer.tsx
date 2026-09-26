import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MonitorExamWorkbenchDetailDto,
  ReportAiFieldDto,
  SemanticConfidenceDto,
  SemanticStatusDto,
} from '@epgs/shared-types';
import { ATTENTION_LEVEL_LABELS, SOURCE_LABELS, SOURCE_TITLES } from './attentionSource';
import { getExamDetail, MonitorApiError } from './monitorApi';
import {
  DIAGNOSIS_TEXT_FIELDS,
  FIELD_LABELS,
  LEVEL_LABELS,
  REPORT_TEXT_FIELDS,
  highlightSegments,
} from './highlight';
import './DetailDrawer.css';

interface DetailDrawerProps {
  /** The monitor_record to load; null closes the drawer. */
  recordId: string | null;
  onClose: () => void;
}

/**
 * 命中处上下文判读结果的医生语言（issue #87）。
 *
 * 刻意不提「模型 / 提示词 / 分类器」这类实现词：医生要判断的是「这条命中该不该
 * 算」，不是一个 AI 系统的内部构造。措辞也只描述报告里那句话，不描述病情。
 */
const SEMANTIC_STATUS_LABELS: Record<SemanticStatusDto, string> = {
  PRESENT: '报告里明确写了这个情况',
  NEGATED: '报告是否定这个情况',
  SUSPECTED: '报告只是疑似/需考虑',
  HISTORY: '只是既往史或背景描述',
  UNCERTAIN: '上下文不足以判断',
};

const SEMANTIC_CONFIDENCE_LABELS: Record<SemanticConfidenceDto, string> = {
  HIGH: '把握高',
  MEDIUM: '把握中',
  LOW: '把握低',
};

/**
 * 证据片段出自报告的哪一部分。与关键词命中的 FIELD_LABELS（highlight.tsx）分开
 * 命名：后者的取值是 MatchFieldDto（含 REPORT_TEXT / OTHER），这里是 AI 任务的
 * ReportAiField（只有三列，见 schema.prisma 的 ReportAiField 注释）。
 */
const REPORT_AI_FIELD_LABELS: Record<ReportAiFieldDto, string> = {
  EXAM_ITEM: '检查项目',
  FINDINGS: '报告内容',
  IMPRESSION: '诊断',
};

function friendlyError(error: unknown): string {
  if (error instanceof MonitorApiError && error.status === 404) {
    return '未找到该检查记录，可能已被移除。';
  }
  if (error instanceof MonitorApiError) return error.message;
  return '请求失败，请检查网络后重试。';
}

export function DetailDrawer({ recordId, onClose }: DetailDrawerProps): JSX.Element | null {
  const [detail, setDetail] = useState<MonitorExamWorkbenchDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);

  /**
   * Distinct keywords to highlight inside 报告内容, from the hits that matched
   * there. Issue #87: only EFFECTIVE hits - highlighting marks "this is why
   * the patient is on the watch list", and a hit that was judged not to
   * express the rule's intent is precisely not that. The filtered hit still
   * appears in 命中证据 below, with its own annotation.
   */
  const reportKeywords = useMemo(() => {
    if (!detail) return [];
    return Array.from(
      new Set(
        detail.hits
          .filter((hit) => !hit.semanticFiltered && REPORT_TEXT_FIELDS.includes(hit.matchedField))
          .map((hit) => hit.keyword),
      ),
    );
  }, [detail]);

  /** Distinct keywords to highlight inside 诊断, from the effective hits there. */
  const diagnosisKeywords = useMemo(() => {
    if (!detail) return [];
    return Array.from(
      new Set(
        detail.hits
          .filter(
            (hit) => !hit.semanticFiltered && DIAGNOSIS_TEXT_FIELDS.includes(hit.matchedField),
          )
          .map((hit) => hit.keyword),
      ),
    );
  }, [detail]);

  /** How many hits were judged not to count - shown next to the hit count. */
  const filteredCount = useMemo(
    () => (detail ? detail.hits.filter((hit) => hit.semanticFiltered).length : 0),
    [detail],
  );

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
              {/*
                等级标签与来源徽标同一行：drawer__summary 是 grid，直接并排会被拆成
                两行，所以这里自己是一个 flex 行。徽标 NONE 不渲染 —— 两条路径都没发现
                内容时等级是未分级，再加一个「都没有」的徽标只是噪音。
              */}
              <p className="drawer__level-line">
                <span className={`level-tag level-tag--${detail.monitorLevel.toLowerCase()}`}>
                  {LEVEL_LABELS[detail.monitorLevel]}
                </span>
                {detail.attentionSource !== 'NONE' && (
                  <span className="source-badge" title={SOURCE_TITLES[detail.attentionSource]}>
                    {SOURCE_LABELS[detail.attentionSource]}
                  </span>
                )}
              </p>
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
                {filteredCount > 0 && (
                  <span className="drawer__count-note">其中 {filteredCount} 条未计入关注</span>
                )}
              </h3>
              {detail.hits.length === 0 ? (
                <p className="drawer__placeholder">暂无命中记录</p>
              ) : (
                <ul className="drawer__hits">
                  {detail.hits.map((hit) => (
                    <li
                      className={
                        hit.semanticFiltered ? 'drawer__hit drawer__hit--filtered' : 'drawer__hit'
                      }
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
                        {/*
                          未计入关注的命中不隐藏：关键词引擎命中过是事实，医生需要
                          看到它、看到为什么不算数，再自己决定要不要留意。
                        */}
                        {hit.semanticFiltered && (
                          <span className="drawer__hit-flag">未计入关注</span>
                        )}
                      </div>
                      <blockquote className="drawer__snippet">{hit.contextSnippet}</blockquote>
                      {hit.semantic && (
                        <p className="drawer__hit-semantic">
                          <span className="drawer__hit-semantic-label">上下文判读</span>
                          {SEMANTIC_STATUS_LABELS[hit.semantic.status]}
                          <span className="drawer__hit-semantic-confidence">
                            （{SEMANTIC_CONFIDENCE_LABELS[hit.semantic.confidence]}）
                          </span>
                          {hit.semantic.reason && (
                            <span className="drawer__hit-semantic-reason">
                              {hit.semantic.reason}
                            </span>
                          )}
                        </p>
                      )}
                      <p className="drawer__hit-meta">
                        规则 {hit.ruleId.slice(0, 8)} · v{hit.ruleVersion}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/*
              AI 语义发现（issue #88）放在命中证据之后，保留抽屉既有的阅读顺序：先看
              关键词命中了什么，再看整份报告被读出了什么。对一个只有语义发现的记录，
              上面显示「暂无命中记录」，这一段正好解释它为什么在列表里。

              两种情况才渲染：(a) 有发现；(b) 判读过但没发现。都没发生（未判读，或
              判读结果因报告换版而作废）时整段不出现 —— 那正是 #88 之前的界面，不会
              凭空说一句「看过了」。
            */}
            {detail.aiSemantics.length > 0 ? (
              <section className="drawer__section drawer__section--ai">
                <h3>
                  AI 语义发现 <span className="drawer__count">{detail.aiSemantics.length}</span>
                </h3>
                <ul className="drawer__ai-list">
                  {detail.aiSemantics.map((finding) => (
                    <li className="drawer__ai-item" key={finding.semanticId}>
                      <div className="drawer__ai-head">
                        <span
                          className={`level-tag level-tag--${finding.attentionLevel.toLowerCase()}`}
                        >
                          {ATTENTION_LEVEL_LABELS[finding.attentionLevel]}
                        </span>
                        <strong>{finding.name}</strong>
                        <span className="drawer__ai-confidence">
                          {SEMANTIC_CONFIDENCE_LABELS[finding.confidence]}
                        </span>
                      </div>
                      {finding.reason && <p className="drawer__ai-reason">{finding.reason}</p>}
                      {/*
                        证据按服务端重算好的原文渲染，绝不回头去切 reportContent ——
                        报告正文只在「报告内容」区块出现一次，且从不被改写
                        （highlight.tsx 的「只切片、不改写」契约）。
                      */}
                      {finding.evidence.map((evidence, index) => (
                        <blockquote
                          className="drawer__snippet drawer__ai-evidence"
                          key={`${finding.semanticId}-${evidence.field}-${index}`}
                        >
                          <span className="drawer__ai-evidence-field">
                            {REPORT_AI_FIELD_LABELS[evidence.field]}
                          </span>
                          {evidence.text}
                        </blockquote>
                      ))}
                    </li>
                  ))}
                </ul>
                <p className="drawer__ai-note">关注等级不是诊断结论，也不代表病情严重程度。</p>
              </section>
            ) : detail.aiJudged ? (
              <section className="drawer__section drawer__section--ai">
                <h3>AI 语义发现</h3>
                <p className="drawer__placeholder">本次 AI 语义判读未发现需要关注的内容</p>
                <p className="drawer__ai-note">关注等级不是诊断结论，也不代表病情严重程度。</p>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    </aside>
  );
}
