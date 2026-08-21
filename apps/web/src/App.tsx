import { useState } from 'react';
import { AuthGate } from './AuthGate';
import type { AuthUser } from './authApi';
import { RulesModal } from './RulesModal';
import { Workbench } from './Workbench';
import './App.css';

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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand__mark">EP</span>
          <span>菏泽市肿瘤中医医院</span>
        </div>
        <div className="app-header__actions">
          <nav aria-label="主导航" className="app-header__nav">
            <strong>内镜中心</strong>
          </nav>
          <span className="app-user" aria-label="当前用户">
            {user.displayName}
          </span>
          <button type="button" onClick={openChangePassword}>
            修改密码
          </button>
          <button type="button" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </header>
      <Workbench onOpenRules={() => setRulesOpen(true)} />
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} actorId={user.username} />
    </main>
  );
}

function App(): JSX.Element {
  return <AuthGate>{(session) => <AuthenticatedApp {...session} />}</AuthGate>;
}

export default App;
