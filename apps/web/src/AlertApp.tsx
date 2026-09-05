import { useEffect, useMemo, useState } from 'react';
import type { AlertLinkSummaryDto, MonitorExamDetailDto, MonitorExamDto } from '@epgs/shared-types';
import {
  AlertLinkApiError,
  getAlertLinkExamDetail,
  getAlertLinkSummary,
  listAlertLinkExams,
  resolveAlertToken,
} from './alertLinkApi';
import {
  DIAGNOSIS_TEXT_FIELDS,
  FIELD_LABELS,
  LEVEL_LABELS,
  REPORT_TEXT_FIELDS,
  highlightSegments,
  keywordsFor,
} from './highlight';
import './AlertApp.css';

/**
 * The WeCom alert H5 page (issue #72): opened from a per-level card in the
 * push message, it shows that level's frozen patient list (names masked) and,
 * on tap, one record's report with hit highlights. Mobile-first, no login -
 * the link token is the credential (see alertLinkApi.ts). Deliberately
 * separate from the workbench shell (App/AuthGate): different credential,
 * different audience, no navigation into the workbench except the explicit
 * "登录工作台" link at the bottom.
 */

type Phase = 'loading' | 'ready' | 'invalid' | 'expired' | 'error';

const SHANGHAI_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatShanghai(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : SHANGHAI_TIME.format(date);
}

function phaseForError(error: unknown): Phase {
  if (error instanceof AlertLinkApiError) {
    if (error.status === 410) return 'expired';
    if (error.status === 401) return 'invalid';
  }
  return 'error';
}

function formatPatientType(exam: MonitorExamDto): string {
  return exam.patientType.name ?? exam.patientType.code ?? '—';
}

export function AlertApp(): JSX.Element {
  const [token] = useState<string | null>(() => resolveAlertToken());
  const [phase, setPhase] = useState<Phase>(token ? 'loading' : 'invalid');
  const [summary, setSummary] = useState<AlertLinkSummaryDto | null>(null);
  const [items, setItems] = useState<MonitorExamDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    setPhase('loading');
    Promise.all([getAlertLinkSummary(token), listAlertLinkExams(token)])
      .then(([nextSummary, list]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setItems(list.items);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase(phaseForError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  useEffect(() => {
    document.title = summary
      ? `${LEVEL_LABELS[summary.level]}关注 ${summary.total} 例 · ${summary.windowDate}`
      : '患者关注列表';
  }, [summary]);

  if (phase === 'loading') {
    return (
      <main className="alert-page">
        <p className="alert-state" role="status">
          正在打开关注列表…
        </p>
      </main>
    );
  }

  if (phase !== 'ready' || !summary) {
    return (
      <main className="alert-page">
        <section className="alert-state alert-state--block" role="alert">
          {phase === 'expired' && (
            <>
              <h1>链接已失效</h1>
              <p>这条关注链接已超过有效期。请登录工作台查看最新情况。</p>
            </>
          )}
          {phase === 'invalid' && (
            <>
              <h1>链接无效</h1>
              <p>请从企业微信的推送消息重新打开；如仍无法打开，请登录工作台查看。</p>
            </>
          )}
          {phase === 'error' && (
            <>
              <h1>暂时无法打开</h1>
              <p>请检查网络后重试。</p>
              <button
                type="button"
                className="alert-button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                重新加载
              </button>
            </>
          )}
          <a className="alert-link" href="/">
            登录工作台
          </a>
        </section>
      </main>
    );
  }

  const levelClass = summary.level.toLowerCase();
  const selected = selectedId ? (items.find((exam) => exam.recordId === selectedId) ?? null) : null;

  return (
    <main className={`alert-page alert-page--${levelClass}`}>
      <header className="alert-header">
        <p className="alert-header__eyebrow">{summary.hospitalName} · 内镜重点患者监测</p>
        <div className="alert-header__title">
          <span className={`level-tag level-tag--${levelClass}`}>
            {LEVEL_LABELS[summary.level]}关注
          </span>
          <h1>
            {summary.windowDate} · 共 {summary.total} 例
          </h1>
        </div>
        <p className="alert-header__expiry">
          本链接有效至 {formatShanghai(summary.expiresAt)}，为保护患者隐私请勿转发；姓名已脱敏。
        </p>
      </header>

      {selected && token ? (
        <AlertDetail token={token} exam={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <section className="alert-list" aria-label="患者列表">
          {items.length === 0 ? (
            <p className="alert-state">该列表当前没有可显示的记录（记录可能已被移除）。</p>
          ) : (
            <ul>
              {items.map((exam) => (
                <li key={exam.recordId}>
                  <button
                    type="button"
                    className={`alert-row alert-row--${exam.monitorLevel.toLowerCase()}`}
                    onClick={() => setSelectedId(exam.recordId)}
                  >
                    <span className="alert-row__head">
                      <strong>{exam.patientName ?? '—'}</strong>
                      <span className="alert-row__bed">{exam.bedNo ?? '—'}</span>
                      <span className="alert-row__dept">{exam.department ?? '—'}</span>
                    </span>
                    <span className="alert-row__meta">
                      {exam.examItem ?? '—'} · {formatPatientType(exam)} · {exam.examTime ?? '—'}
                    </span>
                    <span className="alert-row__keywords">
                      {exam.matchedKeywords.length > 0
                        ? exam.matchedKeywords.join('、')
                        : '无命中关键词'}
                    </span>
                    <span className="alert-row__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <footer className="alert-footer">
        <p>关键词分级仅用于监测提示，不作为正式诊断或病情严重程度判断。</p>
        <a className="alert-link" href="/">
          登录工作台查看完整信息 →
        </a>
      </footer>
    </main>
  );
}

interface AlertDetailProps {
  token: string;
  exam: MonitorExamDto;
  onBack: () => void;
}

function AlertDetail({ token, exam, onBack }: AlertDetailProps): JSX.Element {
  const [detail, setDetail] = useState<MonitorExamDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getAlertLinkExamDetail(token, exam.recordId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof AlertLinkApiError && requestError.status === 404) {
          setError('未找到该检查记录，可能已被移除。');
        } else if (requestError instanceof AlertLinkApiError && requestError.status === 410) {
          setError('链接已失效，请登录工作台查看。');
        } else {
          setError('请求失败，请检查网络后重试。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, exam.recordId, reloadKey]);

  const reportKeywords = useMemo(
    () => (detail ? keywordsFor(detail.hits, REPORT_TEXT_FIELDS) : []),
    [detail],
  );
  const diagnosisKeywords = useMemo(
    () => (detail ? keywordsFor(detail.hits, DIAGNOSIS_TEXT_FIELDS) : []),
    [detail],
  );

  return (
    <section className="alert-detail" aria-label="检查详情">
      <button type="button" className="alert-back" onClick={onBack}>
        ‹ 返回列表
      </button>

      <div className="alert-detail__summary">
        <span className={`level-tag level-tag--${exam.monitorLevel.toLowerCase()}`}>
          {LEVEL_LABELS[exam.monitorLevel]}
        </span>
        <h2>
          {exam.patientName ?? '—'}{' '}
          <small>
            {exam.bedNo ?? '—'} · {exam.department ?? '—'}
          </small>
        </h2>
        <dl className="alert-fields">
          <div>
            <dt>检查项目</dt>
            <dd>{exam.examItem ?? '—'}</dd>
          </div>
          <div>
            <dt>检查时间</dt>
            <dd>
              {exam.examDate ?? '—'} {exam.examTime ?? ''}
            </dd>
          </div>
          <div>
            <dt>患者类型</dt>
            <dd>{formatPatientType(exam)}</dd>
          </div>
          <div>
            <dt>命中关键词</dt>
            <dd>{exam.matchedKeywords.length > 0 ? exam.matchedKeywords.join('、') : '—'}</dd>
          </div>
        </dl>
      </div>

      {error ? (
        <div className="alert-state alert-state--block" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="alert-button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            重新加载
          </button>
        </div>
      ) : !detail ? (
        <p className="alert-state" role="status">
          正在加载报告…
        </p>
      ) : (
        <>
          <section className="alert-section">
            <h3>报告内容</h3>
            <p className="alert-text">
              {detail.reportContent ? (
                highlightSegments(detail.reportContent, reportKeywords)
              ) : (
                <span className="alert-placeholder">暂无报告内容（未同步到报告正文）</span>
              )}
            </p>
          </section>

          <section className="alert-section">
            <h3>诊断</h3>
            <p className="alert-text">
              {detail.diagnosis ? (
                highlightSegments(detail.diagnosis, diagnosisKeywords)
              ) : (
                <span className="alert-placeholder">暂无诊断（未同步到诊断意见）</span>
              )}
            </p>
          </section>

          <section className="alert-section">
            <h3>
              命中证据 <span className="alert-count">{detail.hits.length}</span>
            </h3>
            {detail.hits.length === 0 ? (
              <p className="alert-placeholder">暂无命中记录</p>
            ) : (
              <ul className="alert-hits">
                {detail.hits.map((hit) => (
                  <li
                    key={`${hit.ruleId}-${hit.matchedField}-${hit.keyword}`}
                    className="alert-hit"
                  >
                    <div className="alert-hit__head">
                      <span className={`level-tag level-tag--${hit.level.toLowerCase()}`}>
                        {LEVEL_LABELS[hit.level]}
                      </span>
                      <strong>{hit.keyword}</strong>
                      <span className="alert-hit__field">{FIELD_LABELS[hit.matchedField]}</span>
                    </div>
                    {hit.contextSnippet && (
                      <blockquote className="alert-hit__snippet">{hit.contextSnippet}</blockquote>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
