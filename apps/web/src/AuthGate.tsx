import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { AuthApiError, AuthUser, changePassword, getCurrentUser, login, logout } from './authApi';
import hospitalLogo from './assets/hospital-logo.jpg';
import './AuthGate.css';

interface AuthContext {
  user: AuthUser;
  logout(): Promise<void>;
  openChangePassword(): void;
}

interface AuthGateProps {
  children(context: AuthContext): ReactNode;
}

function errorMessage(error: unknown, action: 'login' | 'change'): string {
  if (error instanceof AuthApiError) {
    if (action === 'login' && error.status === 401) return '账号或密码错误';
    if (error.code === 'AUTH_CURRENT_PASSWORD_INVALID') return '当前密码错误';
    if (error.code === 'AUTH_PASSWORD_REUSED') return '新密码不能与当前密码相同';
    if (error.status === 401) return '登录状态已失效，请重新登录';
  }
  return '操作失败，请稍后重试';
}

export function AuthGate({ children }: AuthGateProps): JSX.Element {
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const requireLogin = (): void => {
      setUser(null);
      setChangeOpen(false);
      setLoginError('登录状态已失效，请重新登录');
    };
    window.addEventListener('epgs:auth-required', requireLogin);
    return () => window.removeEventListener('epgs:auth-required', requireLogin);
  }, []);

  useEffect(() => {
    if (!changeOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setChangeOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [changeOpen]);

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoginBusy(true);
    setLoginError('');
    setSuccessMessage('');
    try {
      setUser(await login(String(form.get('username') ?? ''), String(form.get('password') ?? '')));
    } catch (error) {
      setLoginError(errorMessage(error, 'login'));
    } finally {
      setLoginBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');
    const errorElement = event.currentTarget.querySelector<HTMLElement>('[data-change-error]');
    if (newPassword.length < 8 || newPassword !== confirmPassword) {
      if (errorElement) {
        errorElement.textContent =
          newPassword.length < 8 ? '新密码至少需要 8 个字符' : '两次输入的新密码不一致';
      }
      return;
    }
    const submit = event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    if (errorElement) errorElement.textContent = '';
    try {
      await changePassword(currentPassword, newPassword, confirmPassword);
      setChangeOpen(false);
      setUser(null);
      setSuccessMessage('密码修改成功，请使用新密码重新登录。');
    } catch (error) {
      if (errorElement) errorElement.textContent = errorMessage(error, 'change');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function endSession(): Promise<void> {
    try {
      await logout();
    } catch {
      // The local view must still close if the server is temporarily unavailable.
    } finally {
      setUser(null);
      setChangeOpen(false);
    }
  }

  if (checking) {
    return <div className="auth-loading">正在验证登录状态…</div>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-brand" aria-label="系统信息">
          <span className="login-brand__mark">
            <img src={hospitalLogo} alt="菏泽市中医医院" />
          </span>
          <p>菏泽市中医医院</p>
          <h1>内镜重点患者监测系统</h1>
          <span>院内数据展示 · 授权访问</span>
        </section>
        <section className="login-panel">
          <div className="login-panel__content">
            <p className="login-kicker">ENDOSCOPY MONITORING</p>
            <h2>登录系统</h2>
            <p className="login-intro">请使用管理员分配的院内账号登录</p>
            {successMessage && <p className="auth-success">{successMessage}</p>}
            {loginError && (
              <p role="alert" className="auth-error">
                {loginError}
              </p>
            )}
            <form onSubmit={(event) => void submitLogin(event)}>
              <label>
                <span>账号</span>
                <input name="username" autoComplete="username" required autoFocus />
              </label>
              <label>
                <span>密码</span>
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              <button type="submit" disabled={loginBusy}>
                {loginBusy ? '登录中…' : '登录'}
              </button>
            </form>
            <p className="login-help">忘记密码请联系系统管理员</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <>
      {children({ user, logout: endSession, openChangePassword: () => setChangeOpen(true) })}
      {changeOpen && (
        <div className="auth-modal-backdrop" role="presentation">
          <section
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-password-title"
          >
            <div className="auth-modal__header">
              <div>
                <p className="login-kicker">ACCOUNT SECURITY</p>
                <h2 id="change-password-title">修改密码</h2>
              </div>
              <button
                type="button"
                className="auth-modal__close"
                aria-label="关闭"
                onClick={() => setChangeOpen(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(event) => void submitPasswordChange(event)}>
              <label>
                <span>当前密码</span>
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                />
              </label>
              <label>
                <span>新密码</span>
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              <label>
                <span>确认新密码</span>
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              <p className="auth-error auth-error--reserved" role="alert" data-change-error />
              <div className="auth-modal__actions">
                <button type="button" className="secondary" onClick={() => setChangeOpen(false)}>
                  取消
                </button>
                <button type="submit">确认修改</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
