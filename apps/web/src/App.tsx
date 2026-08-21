import { useState } from 'react';
import { ApiStatus } from './ApiStatus';
import { RulesModal } from './RulesModal';
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
        <nav aria-label="主导航">
          <strong>内镜中心</strong>
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
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </main>
  );
}

export default App;
