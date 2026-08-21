import { ApiStatus } from './ApiStatus';

/**
 * Placeholder landing page for the EPGS frontend skeleton (issue #1).
 * Real business pages (patient lists, monitor rules, etc.) come in
 * later issues (#9+) - this only proves the app boots and can reach
 * the API's /health endpoint.
 */
function App(): JSX.Element {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>内镜中心</h1>
      <p>内镜重点患者监测系统 - 工程骨架占位页面</p>
      <ApiStatus />
    </main>
  );
}

export default App;
