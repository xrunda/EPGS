import { useState } from 'react';
import { ApiStatus } from './ApiStatus';
import { RulesModal } from './RulesModal';
import { AuthGate } from './AuthGate';
import type { AuthUser } from './authApi';
import './App.css';

/** Application shell for the endoscopy monitoring workbench. */
function Workbench({
  user,
  logout,
  openChangePassword,
}: {
  user: AuthUser;
  logout(): Promise<void>;
  openChangePassword(): void;
}): JSX.Element {
  const [rulesOpen, setRulesOpen] = useState(false);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand__mark">EP</span>
          <span>菏泽市肿瘤中医医院</span>
        </div>
        <nav aria-label="主导航" className="app-header__nav">
          <strong>内镜中心</strong>
          <span className="app-user">{user.displayName}</span>
          <button type="button" onClick={openChangePassword}>
            修改密码
          </button>
          <button type="button" onClick={() => void logout()}>
            退出登录
          </button>
        </nav>
      </header>
      <section className="app-workbench">
        <div>
          <p className="app-kicker">ENDOSCOPY MONITORING</p>
          <h1>内镜中心</h1>
          <p>内镜重点患者监测系统</p>
        </div>
        <button className="app-rules-button" type="button" onClick={() => setRulesOpen(true)}>
          监测规则
        </button>
      </section>
      <div className="app-status">
        <ApiStatus />
      </div>
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} actorId={user.username} />
    </main>
  );
}

function App(): JSX.Element {
  return <AuthGate>{(session) => <Workbench {...session} />}</AuthGate>;
}

export default App;
