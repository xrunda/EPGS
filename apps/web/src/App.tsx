import { useState } from 'react';
import { ActionMenu } from './ActionMenu';
import { AuthGate } from './AuthGate';
import type { AuthUser } from './authApi';
import { ExportModal } from './ExportModal';
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
  const [exportOpen, setExportOpen] = useState(false);
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
          {/*
            使用手册（issue #147）。它链的是同源静态页 /manual.html，不是 GitHub：
            堡垒机在网闸后面，医生的浏览器打不开 github.com，仓库链接对真实用户是死链。
            静态文件放在 apps/web/public/，Vite 会原样拷进 dist/，nginx 的 try_files
            先看磁盘因而直接命中 —— 不需要改 nginx 模板或 start.sh。
            必须写**确切文件名**：不带扩展名的 /manual 会被 SPA 回落吞掉，
            返回一个 200 的空应用页而不是 404（这条由 manual-page.test.ts 钉住）。

            用 <a href> 而不是 <button onClick={window.open}>：它就是一个链接，
            中键、右键"复制链接地址"都该正常工作，也不吃弹窗拦截。
            放顶栏而不是工作台工具栏：工具栏那排入口全是按权限传 prop 门控的，
            而手册对**没有任何权限的只读医生**同样必须可读；这里无条件渲染。
            target=_blank 让医生在第二个标签页里边看边做，不丢工作台的筛选状态。
          */}
          <a className="app-header__help" href="/manual.html" target="_blank" rel="noopener">
            使用手册
          </a>
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
        /*
          #139 与上面几条不同：它判的不是角色，而是患者明细授权。没有被授予
          patientDetail 的账号（例如只看得到脱敏字段的医生）不该看到一个点下去必然
          403 的入口 —— 传 undefined，按钮就不渲染。服务端仍然独立判定一次。
        */
        onOpenExport={user.patientDetail ? () => setExportOpen(true) : undefined}
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
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
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
