import { useState } from 'react';
import { RulesModal } from './RulesModal';
import { Workbench } from './Workbench';
import './App.css';

/** Application shell for the endoscopy monitoring workbench. */
function App(): JSX.Element {
  const [rulesOpen, setRulesOpen] = useState(false);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand__mark">EP</span>
          <span>菏泽市肿瘤中医医院</span>
        </div>
        <div className="app-header__actions">
          <nav aria-label="主导航">
            <strong>内镜中心</strong>
          </nav>
          <span
            className="app-user"
            title="登录与权限将在权限与审计功能中接入"
            aria-label="当前用户"
          >
            操作员 · 未登录
          </span>
        </div>
      </header>
      <Workbench onOpenRules={() => setRulesOpen(true)} />
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </main>
  );
}

export default App;
