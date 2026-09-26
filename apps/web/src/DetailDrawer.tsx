import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AttentionLevelDto,
  MonitorAiSemanticDto,
  MonitorExamHitDto,
  MonitorExamWorkbenchDetailDto,
  MonitorLevelDto,
  ReportAiFieldDto,
  SemanticConfidenceDto,
  SemanticStatusDto,
} from '@epgs/shared-types';
import { ATTENTION_LEVEL_LABELS } from './attentionSource';
import { attentionReason } from './attentionReason';
import { getExamDetail, MonitorApiError } from './monitorApi';
import {
  DIAGNOSIS_TEXT_FIELDS,
  FIELD_LABELS,
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
 * 「关注依据」列表里的一条：关键词命中，或整份报告读出来的一条发现。两者本来就
 * 回答同一个问题（这条记录为什么需要关注），issue #94 把它们合成一个列表。
 */
type ReasonItem =
  | { kind: 'hit'; level: MonitorLevelDto; hit: MonitorExamHitDto }
  | { kind: 'finding'; level: AttentionLevelDto; finding: MonitorAiSemanticDto };

/** 关注等级优先级：理由列表按它排，与等级本身的计算口径一致。 */
const LEVEL_ORDER: Record<MonitorLevelDto, number> = {
  RED: 0,
  YELLOW: 1,
  GREEN: 2,
  UNCLASSIFIED: 3,
};

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
   * appears in 关注依据 below, with its own annotation.
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

  /**
   * 「关注依据」= 关键词命中 + 整份报告读出来的发现，一个列表（issue #94）。
   *
   * 排序只看两件事：关注等级优先级（RED → YELLOW → GREEN），同级先命中后发现。
   * 同级同类的先后保持服务端给的顺序 —— 命中按 matchedAt、发现按各自的 ordinal
   * 早就排好了，这里不重新发明顺序，只做一次稳定归并（Array.sort 自 ES2019 起稳定）。
   */
  const reasonItems = useMemo<ReasonItem[]>(() => {
    if (!detail) return [];
    const items: ReasonItem[] = [
      ...detail.hits.map((hit): ReasonItem => ({ kind: 'hit', level: hit.level, hit })),
      ...detail.aiSemantics.map(
        (finding): ReasonItem => ({ kind: 'finding', level: finding.attentionLevel, finding }),
      ),
    ];
    return items.sort(
      (a, b) =>
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
        (a.kind === b.kind ? 0 : a.kind === 'hit' ? -1 : 1),
    );
  }, [detail]);

  /**
   * 一句话说清「这位患者为什么需要关注」。没有理由时为 null，摘要区就不显示这一行。
   */
  const reason = useMemo(() => (detail ? attentionReason(detail) : null), [detail]);

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
                等级标签与理由句同一个 flex 行：drawer__summary 是 grid，直接并排会被
                拆成两行，所以这里自己是一个容器。理由句用 flex-basis:100% 独占下一行，
                但仍然紧贴等级标签 —— 医生读到的是「红色关注 / 为什么是红色」，而不是
                先看到等级、翻到下面才知道原因（issue #94）。

                来源徽标（issue #88）已从临床视图移除：理由句本身就说清了是什么让这位
                患者需要关注，再加一个「哪个引擎发现的他」只是机制噪音。
              */}
              <div className="drawer__level-line">
                {/*
                  主等级标签与下面「关注依据」里的等级标签用同一份文案
                  （attentionSource.ts），所以同一屏里不会一处写「红色」、一处写
                  「红色关注」。
                */}
                <span className={`level-tag level-tag--${detail.monitorLevel.toLowerCase()}`}>
                  {ATTENTION_LEVEL_LABELS[detail.monitorLevel]}
                </span>
                {reason !== null && <p className="drawer__reason">{reason}</p>}
              </div>
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

            {/*
              关注依据（issue #94）：原来的「命中证据」与「AI 语义发现」两个并列区块
              合成一个列表。医生要回答的是「这位患者为什么需要关注」，而不是「哪个引擎
              发现了他」—— 两个区块并列，等于把这个系统的内部分工端到医生眼前，让他
              自己在脑子里合并。

              合并的是说法与结构，不是理由本身：没有任何关键词命中、只因整份报告被读出
              问题而为红色的记录，依据列表里仍然有那一条发现和它的证据，段末的提示也
              照旧（这是本 Issue 最主要的失败模式，验收标准里有三条挡着它）。
            */}
            <section className="drawer__section drawer__section--reasons">
              <h3>
                关注依据 <span className="drawer__count">{reasonItems.length}</span>
                {filteredCount > 0 && (
                  <span className="drawer__count-note">其中 {filteredCount} 条未计入关注</span>
                )}
              </h3>
              {reasonItems.length === 0 ? (
                <p className="drawer__placeholder">暂无关注依据</p>
              ) : (
                <ul className="drawer__hits">
                  {reasonItems.map((item) =>
                    item.kind === 'hit' ? (
                      <li
                        className={
                          item.hit.semanticFiltered
                            ? 'drawer__hit drawer__hit--filtered'
                            : 'drawer__hit'
                        }
                        key={`hit-${item.hit.ruleId}-${item.hit.matchedField}-${item.hit.keyword}`}
                      >
                        <div className="drawer__hit-head">
                          {/*
                            等级标签与下面每条依据、以及摘要区的主标签用同一份文案
                            （attentionSource.ts）：同一个列表里一处写「红色」、一处写
                            「红色关注」才是最费解的。
                          */}
                          <span className={`level-tag level-tag--${item.hit.level.toLowerCase()}`}>
                            {ATTENTION_LEVEL_LABELS[item.hit.level]}
                          </span>
                          <strong>{item.hit.keyword}</strong>
                          <span className="drawer__field-label">
                            {FIELD_LABELS[item.hit.matchedField]}
                          </span>
                          {/*
                            未计入关注的命中不隐藏：关键词引擎命中过是事实，医生需要
                            看到它、看到为什么不算数，再自己决定要不要留意。
                          */}
                          {item.hit.semanticFiltered && (
                            <span className="drawer__hit-flag">未计入关注</span>
                          )}
                        </div>
                        <blockquote className="drawer__snippet">{item.hit.contextSnippet}</blockquote>
                        {item.hit.semantic && (
                          <p className="drawer__hit-semantic">
                            <span className="drawer__hit-semantic-label">结合上下文</span>
                            {SEMANTIC_STATUS_LABELS[item.hit.semantic.status]}
                            <span className="drawer__hit-semantic-confidence">
                              （{SEMANTIC_CONFIDENCE_LABELS[item.hit.semantic.confidence]}）
                            </span>
                            {item.hit.semantic.reason && (
                              <span className="drawer__hit-semantic-reason">
                                {item.hit.semantic.reason}
                              </span>
                            )}
                          </p>
                        )}
                        {/*
                          规则 UUID 与 version 是运营/审计标识，issue #94 从临床视图
                          移走（API 契约不变，运营视图仍拿得到）。
                        */}
                      </li>
                    ) : (
                      <li className="drawer__ai-item" key={`finding-${item.finding.semanticId}`}>
                        <div className="drawer__ai-head">
                          <span
                            className={`level-tag level-tag--${item.finding.attentionLevel.toLowerCase()}`}
                          >
                            {ATTENTION_LEVEL_LABELS[item.finding.attentionLevel]}
                          </span>
                          <strong>{item.finding.name}</strong>
                          <span className="drawer__ai-confidence">
                            {SEMANTIC_CONFIDENCE_LABELS[item.finding.confidence]}
                          </span>
                        </div>
                        {item.finding.reason && (
                          <p className="drawer__ai-reason">{item.finding.reason}</p>
                        )}
                        {/*
                          证据按服务端重算好的原文渲染，绝不回头去切 reportContent ——
                          报告正文只在「报告内容」区块出现一次，且从不被改写
                          （highlight.tsx 的「只切片、不改写」契约）。
                        */}
                        {item.finding.evidence.map((evidence, index) => (
                          <blockquote
                            className="drawer__snippet drawer__ai-evidence"
                            key={`${item.finding.semanticId}-${evidence.field}-${index}`}
                          >
                            <span className="drawer__ai-evidence-field">
                              {REPORT_AI_FIELD_LABELS[evidence.field]}
                            </span>
                            {evidence.text}
                          </blockquote>
                        ))}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {/*
                「看过了，没发现」是一个明确的结论，要和「没看过」分得开 —— 但它只在
                真的判读过、且这一版报告没有任何发现时出现（未判读时整句不出现，不
                凭空说一句「看过了」）。
              */}
              {detail.aiJudged && detail.aiSemantics.length === 0 && (
                <p className="drawer__placeholder">整份报告已核对，未发现需要关注的内容</p>
              )}
              <p className="drawer__ai-note">关注等级不是诊断结论，也不代表病情严重程度。</p>
            </section>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
