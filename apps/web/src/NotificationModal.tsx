import { useCallback, useEffect, useRef, useState } from 'react';
import { ChannelPanel } from './ChannelPanel';
import { TemplatePanel } from './TemplatePanel';
import { TestSendDialog } from './TestSendDialog';
import './NotificationModal.css';

interface NotificationModalProps {
  open: boolean;
  onClose(): void;
  /** 后端 @RequireRoles(SYSTEM_ADMIN) 强校验；此处仅隐藏写入口（UX 优化）。 */
  canManageNotifications?: boolean;
  actorId?: string;
}

type ActiveTab = 'channels' | 'templates';

/** 发送测试对话框的预选（来自渠道/模板行的行内入口）。 */
type TestSendSelection = { channelId?: string; templateId?: string };

const TABS: Array<{ key: ActiveTab; label: string }> = [
  { key: 'channels', label: '渠道' },
  { key: 'templates', label: '模板' },
];

export function NotificationModal({
  open,
  onClose,
  canManageNotifications = true,
  actorId = 'web-operator',
}: NotificationModalProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<ActiveTab>('channels');
  // 抬升的 dirty：任一 panel 的编辑器未保存时门控切 tab 与关闭弹窗
  const [dirty, setDirty] = useState(false);
  const [testSend, setTestSend] = useState<TestSendSelection | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      // 发送测试子对话框打开时由它自己处理 Escape，避免一次按键关闭两层弹窗
      if (event.key === 'Escape' && !testSend) requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose, testSend]);

  if (!open) return null;

  function switchTab(tab: ActiveTab): void {
    if (tab === activeTab) return;
    if (dirty && !window.confirm('当前修改尚未保存，确定切换吗？')) return;
    setDirty(false);
    setActiveTab(tab);
  }

  return (
    <div
      className="notification-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="notification-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-modal-title"
        tabIndex={-1}
      >
        <header className="notification-modal__header">
          <div>
            <p className="notification-modal__eyebrow">内镜中心 · 消息推送配置</p>
            <h2 id="notification-modal-title">消息推送配置</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭消息推送配置"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        <div className="notification-modal__notice">
          <span aria-hidden="true">i</span>
          <p>消息推送配置保存后即时生效；发送测试将真实推送到企业微信。</p>
        </div>

        <div className="notification-tabs" role="tablist" aria-label="消息推送配置分类">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`notification-tab${activeTab === tab.key ? ' notification-tab--active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => switchTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'channels' ? (
          <ChannelPanel
            actorId={actorId}
            canManageNotifications={canManageNotifications}
            onDirtyChange={setDirty}
            onOpenTestSend={setTestSend}
          />
        ) : (
          <TemplatePanel
            actorId={actorId}
            canManageNotifications={canManageNotifications}
            onDirtyChange={setDirty}
            onOpenTestSend={setTestSend}
          />
        )}
      </section>

      {testSend && (
        <TestSendDialog open onClose={() => setTestSend(null)} preselect={testSend} />
      )}
    </div>
  );
}
