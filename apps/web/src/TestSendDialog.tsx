import { useEffect, useRef, useState } from 'react';
import type {
  NotificationChannelDto,
  NotificationTemplateDto,
  TestSendResult,
} from '@epgs/shared-types';
import { formatTimestamp, friendlyError, listChannels, listTemplates, testSend } from './notificationApi';

interface TestSendDialogProps {
  open: boolean;
  onClose(): void;
  /** 从渠道/模板行的"发送测试"入口进入时预选对应下拉。 */
  preselect: { channelId?: string; templateId?: string };
}

export function TestSendDialog({
  open,
  onClose,
  preselect,
}: TestSendDialogProps): JSX.Element | null {
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestSendResult | null>(null);
  const [channelId, setChannelId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    setResult(null);
    Promise.all([listChannels({ pageSize: 100 }), listTemplates({ pageSize: 100 })])
      .then(([channelPage, templatePage]) => {
        if (!active) return;
        setChannels(channelPage.items);
        setTemplates(templatePage.items);
        // 预选 id 不在当前列表（已被删除）时回退空值，避免发送悬空引用
        setChannelId(
          preselect.channelId && channelPage.items.some((item) => item.id === preselect.channelId)
            ? preselect.channelId
            : '',
        );
        setTemplateId(
          preselect.templateId && templatePage.items.some((item) => item.id === preselect.templateId)
            ? preselect.templateId
            : '',
        );
      })
      .catch(() => {
        if (active) setError('加载渠道或模板失败，请稍后重试。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, preselect.channelId, preselect.templateId]);

  useEffect(() => {
    if (!open) return undefined;
    dialogRef.current?.focus();
    // Escape 关闭对话框；父弹窗（NotificationModal）检测到 testSend 已打开时不处理 Escape，
    // 避免一次按键同时关闭两层弹窗。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  async function submit(): Promise<void> {
    if (!channelId || !templateId) return;
    if (!window.confirm('确定发送测试消息吗？将真实推送到所选企业微信渠道。')) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await testSend(channelId, { templateId }));
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="notification-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="notification-modal notification-modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="test-send-title"
        tabIndex={-1}
      >
        <header className="notification-modal__header">
          <div>
            <p className="notification-modal__eyebrow">内镜中心 · 消息推送配置</p>
            <h2 id="test-send-title">发送测试消息</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭发送测试"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="notification-dialog-body">正在加载渠道与模板…</div>
        ) : (
          <div className="notification-dialog-body">
            <label>
              目标渠道
              <select
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                disabled={sending}
              >
                <option value="">选择渠道…</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              测试模板
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={sending}
              >
                <option value="">选择模板…</option>
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            {error && (
              <div className="feedback feedback--error" role="alert">
                {error}
                <button type="button" onClick={() => setError(null)}>
                  关闭
                </button>
              </div>
            )}

            {result && (
              <div className="notification-preview" aria-live="polite">
                {result.renderedTitle && (
                  <p className="notification-preview__title">{result.renderedTitle}</p>
                )}
                <p className="notification-preview__content">{result.renderedContent}</p>
                <small>已发送：{formatTimestamp(result.sentAt)}</small>
              </div>
            )}

            <div className="panel-actions">
              <button className="button" type="button" onClick={onClose} disabled={sending}>
                取消
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={sending || !channelId || !templateId}
                onClick={() => void submit()}
              >
                {sending ? '发送中…' : '发送测试'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
