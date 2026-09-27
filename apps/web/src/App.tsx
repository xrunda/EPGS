import { useState } from 'react';
import { ActionMenu } from './ActionMenu';
import { AuthGate } from './AuthGate';
import type { AuthUser } from './authApi';
import { LevelConflictsModal } from './LevelConflictsModal';
import { NotificationModal } from './NotificationModal';
import { RulesModal } from './RulesModal';
import { SemanticMonitorModal } from './SemanticMonitorModal';
import { UsersModal } from './UsersModal';
import { Workbench } from './Workbench';
import { PushAssistantWidget } from './PushAssistantWidget';
import './App.css';

// Served from apps/web/public so the SAME stable URL doubles as the WeCom
// alert-card cover image (issue #76) in both the dev server and the built dist.
const hospitalLogo = '/hospital-logo.jpg';

interface AuthenticatedAppProps {
  user: AuthUser;
  logout(): Promise<void>;
  openChangePassword(): void;
}

/** Authenticated application shell for the endoscopy monitoring workbench. */
function AuthenticatedApp({
  user,
  logout,
  openChangePassword,
}: AuthenticatedAppProps): JSX.Element {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [aiSemanticsOpen, setAiSemanticsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [levelConflictsOpen, setLevelConflictsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  // The push-assistant「推送日志」link opens the notification modal straight on
  // its 日志 tab; a normal open lands on 渠道.
  const [notificationsTab, setNotificationsTab] = useState<'channels' | 'logs'>('channels');

  const openNotifications = (tab: 'channels' | 'logs' = 'channels'): void => {
    setNotificationsTab(tab);
    setNotificationsOpen(true);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand__mark">
            <img src={hospitalLogo} alt="菏泽市中医医院" />
          </span>
        </div>
        <div className="app-header__actions">
          <nav aria-label="主导航" className="app-header__nav">
            <strong>内镜中心</strong>
          </nav>
          <span className="app-user" aria-label="当前用户">
            {user.displayName}
          </span>
          {/*
            修改密码 / 退出登录收进用户名后面的「⋯」（issue #116）：两个低频操作
            不再跟主功能平铺抢位置。菜单项文案、目标弹窗、行为一律不变，只是换了
            入口位置。
          */}
          <ActionMenu
            label="账号操作"
            triggerClassName="app-header__menu-trigger"
            items={[
              { label: '修改密码', onSelect: openChangePassword },
              { label: '退出登录', onSelect: () => void logout() },
            ]}
          />
        </div>
      </header>
      <Workbench
        onOpenRules={() => setRulesOpen(true)}
        onOpenAiSemantics={() => setAiSemanticsOpen(true)}
        onOpenNotifications={() => openNotifications()}
        onOpenUsers={user.roles.includes('USER_ADMIN') ? () => setUsersOpen(true) : undefined}
        onOpenLevelConflicts={
          user.roles.includes('RULE_ADMIN') ? () => setLevelConflictsOpen(true) : undefined
        }
      />
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} actorId={user.username} />
      <SemanticMonitorModal
        open={aiSemanticsOpen}
        onClose={() => setAiSemanticsOpen(false)}
        canManageAiSemantics={user.roles.includes('RULE_ADMIN')}
        actorId={user.username}
      />
      <UsersModal open={usersOpen} onClose={() => setUsersOpen(false)} />
      <LevelConflictsModal
        open={levelConflictsOpen}
        onClose={() => setLevelConflictsOpen(false)}
        canMarkRead={user.roles.includes('RULE_ADMIN')}
      />
      <NotificationModal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        canManageNotifications={user.roles.includes('SYSTEM_ADMIN')}
        actorId={user.username}
        initialTab={notificationsTab}
      />
      <PushAssistantWidget onOpenLogs={() => openNotifications('logs')} />
    </main>
  );
}

function App(): JSX.Element {
  return <AuthGate>{(session) => <AuthenticatedApp {...session} />}</AuthGate>;
}

export default App;
