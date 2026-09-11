import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppRoleDto, AppUserDto } from '@epgs/shared-types';
import {
  createUser,
  deleteUser,
  getUserAccess,
  listUsers,
  resetUserPassword,
  updateUserAccess,
  updateUserStatus,
  UsersApiError,
} from './usersApi';
import './UsersModal.css';

interface UsersModalProps {
  open: boolean;
  onClose: () => void;
}

interface Filters {
  search: string;
  isActive: '' | 'true' | 'false';
}

interface CreateDraft {
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
}

interface AccessDraft {
  roles: AppRoleDto[];
  patientDetail: boolean;
}

interface PasswordDraft {
  newPassword: string;
  confirmPassword: string;
}

const PAGE_SIZE = 20;

const EMPTY_FILTERS: Filters = { search: '', isActive: '' };
const EMPTY_CREATE_DRAFT: CreateDraft = {
  username: '',
  displayName: '',
  password: '',
  confirmPassword: '',
};
const EMPTY_PASSWORD_DRAFT: PasswordDraft = { newPassword: '', confirmPassword: '' };

const ALL_ROLES: AppRoleDto[] = ['VIEWER', 'RULE_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR', 'USER_ADMIN'];

const ROLE_LABELS: Record<AppRoleDto, string> = {
  VIEWER: '查看者',
  RULE_ADMIN: '规则管理员',
  SYSTEM_ADMIN: '系统管理员',
  AUDITOR: '审计员',
  USER_ADMIN: '用户管理员',
};

function friendlyError(error: unknown): string {
  if (error instanceof UsersApiError) {
    if (error.code === 'USER_ALREADY_EXISTS') return '该账号已存在，请更换账号名。';
    if (error.code === 'LAST_USER_ADMIN_PROTECTED') {
      return '此操作会导致系统内不再有任何用户管理员账号，已阻止。请先给另一个账号分配用户管理员角色。';
    }
    if (error.code === 'USER_NOT_FOUND') return '账号不存在，可能已被删除，请刷新列表。';
    return error.message;
  }
  return '请求失败，请检查网络后重试。';
}

/**
 * Shared client-side password check for both the create form and the reset
 * form - returns the message to show, or null when the pair is acceptable.
 * The server re-validates; this only avoids a pointless round trip.
 */
function validatePassword(password: string, confirmation: string): string | null {
  if (password.length < 8) return '密码至少需要 8 个字符。';
  if (password !== confirmation) return '两次输入的密码不一致。';
  return null;
}

export function UsersModal({ open, onClose }: UsersModalProps): JSX.Element | null {
  const [users, setUsers] = useState<AppUserDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE_DRAFT);
  const [createSaving, setCreateSaving] = useState(false);

  const [accessTarget, setAccessTarget] = useState<AppUserDto | null>(null);
  const [accessDraft, setAccessDraft] = useState<AccessDraft>({ roles: [], patientDetail: false });
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [passwordTarget, setPasswordTarget] = useState<AppUserDto | null>(null);
  const [passwordDraft, setPasswordDraft] = useState<PasswordDraft>(EMPTY_PASSWORD_DRAFT);
  const [passwordSaving, setPasswordSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AppUserDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Username of the row whose 停用/启用 PATCH is in flight, so a double click
  // cannot fire two racing requests whose arrival order decides the final state.
  const [statusBusy, setStatusBusy] = useState<string | null>(null);

  const dialogRef = useRef<HTMLElement>(null);

  const query = useMemo(
    () => ({
      search: appliedFilters.search.trim() || undefined,
      isActive: appliedFilters.isActive === '' ? undefined : appliedFilters.isActive === 'true',
      page,
      pageSize: PAGE_SIZE,
    }),
    [appliedFilters, page],
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listUsers(query);
      setUsers(response.items);
      setTotal(response.total);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, reloadKey]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  /**
   * Discards whichever editor panel is open. Returns false when the operator
   * declined the confirm-discard prompt, so every caller must bail out on
   * false instead of continuing to switch panels behind their back.
   */
  const closeEditors = useCallback((): boolean => {
    if (dirty && !window.confirm('当前修改尚未保存，确定关闭吗？')) return false;
    setCreating(false);
    setAccessTarget(null);
    setPasswordTarget(null);
    setDirty(false);
    return true;
  }, [dirty]);

  const requestClose = useCallback((): void => {
    if (!closeEditors()) return;
    onClose();
  }, [closeEditors, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 删除确认框是盖在用户管理之上的模态，Escape 只应关掉它本身。
      if (deleteTarget) {
        if (!deleteBusy) setDeleteTarget(null);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, requestClose, deleteTarget, deleteBusy]);

  if (!open) return null;

  function openCreate(): void {
    if (!closeEditors()) return;
    setCreating(true);
    setCreateDraft(EMPTY_CREATE_DRAFT);
    setNotice(null);
  }

  /**
   * `skipDirtyCheck`: used by saveCreate()'s auto-transition into this same
   * account's access editor right after a successful create - there is
   * nothing unsaved to discard at that point (the account write already
   * succeeded), so re-running closeEditors()'s confirm-discard prompt would
   * be misleading. User-initiated opens (clicking "授权" in the table) go
   * through the default path and still get the discard guard via
   * closeEditors().
   */
  async function openAccess(user: AppUserDto, skipDirtyCheck = false): Promise<void> {
    if (skipDirtyCheck) {
      setCreating(false);
      setPasswordTarget(null);
    } else if (!closeEditors()) {
      return;
    }
    setAccessTarget(user);
    setAccessLoading(true);
    setNotice(null);
    setError(null);
    try {
      const access = await getUserAccess(user.username);
      setAccessDraft({ roles: access.roles, patientDetail: access.patientDetail });
    } catch (requestError) {
      setError(friendlyError(requestError));
      setAccessTarget(null);
    } finally {
      setAccessLoading(false);
    }
  }

  function openPassword(user: AppUserDto): void {
    if (!closeEditors()) return;
    setPasswordTarget(user);
    setPasswordDraft(EMPTY_PASSWORD_DRAFT);
    setNotice(null);
  }

  async function saveCreate(): Promise<void> {
    if (!createDraft.username.trim() || !createDraft.displayName.trim()) {
      setError('请填写账号和显示名。');
      return;
    }
    const passwordError = validatePassword(createDraft.password, createDraft.confirmPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setCreateSaving(true);
    setError(null);
    try {
      const created = await createUser({
        username: createDraft.username.trim(),
        displayName: createDraft.displayName.trim(),
        password: createDraft.password,
        confirmPassword: createDraft.confirmPassword,
      });
      setNotice(`账号 ${created.username} 已创建，请继续分配角色`);
      setDirty(false);
      setReloadKey((current) => current + 1);
      // 保存后自动展开授权编辑区：避免创建后忘记授权，新账号登录即全部 403。
      // skipDirtyCheck=true：创建已成功，没有"未保存的修改"可言，不应再弹放弃确认框。
      await openAccess(created, true);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setCreateSaving(false);
    }
  }

  function toggleRole(role: AppRoleDto): void {
    setAccessDraft((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role],
    }));
    setDirty(true);
  }

  async function saveAccess(): Promise<void> {
    if (!accessTarget) return;
    setAccessSaving(true);
    setError(null);
    try {
      await updateUserAccess(accessTarget.username, {
        roles: accessDraft.roles,
        patientDetail: accessDraft.patientDetail,
      });
      setNotice('授权已保存');
      setUsers((current) =>
        current.map((item) =>
          item.username === accessTarget.username
            ? { ...item, roles: accessDraft.roles, patientDetail: accessDraft.patientDetail }
            : item,
        ),
      );
      setAccessTarget(null);
      setDirty(false);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setAccessSaving(false);
    }
  }

  async function savePassword(): Promise<void> {
    if (!passwordTarget) return;
    const passwordError = validatePassword(passwordDraft.newPassword, passwordDraft.confirmPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    setPasswordSaving(true);
    setError(null);
    try {
      await resetUserPassword(passwordTarget.username, passwordDraft);
      setNotice(`已重置 ${passwordTarget.username} 的密码，请线下告知本人`);
      setPasswordTarget(null);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function toggleStatus(user: AppUserDto): Promise<void> {
    if (statusBusy === user.username) return;
    setStatusBusy(user.username);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateUserStatus(user.username, { isActive: !user.isActive });
      setUsers((current) => current.map((item) => (item.username === user.username ? updated : item)));
      setNotice(updated.isActive ? '账号已启用' : '账号已停用');
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setStatusBusy(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await deleteUser(deleteTarget.username);
      setNotice(`账号 ${deleteTarget.username} 已删除`);
      setDeleteTarget(null);
      // 删掉本页最后一条后，当前页会变空：先回退一页再重新拉取，否则界面停在空页。
      if (users.length === 1 && page > 1) setPage(page - 1);
      setReloadKey((current) => current + 1);
    } catch (requestError) {
      setError(friendlyError(requestError));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div
      className="users-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="users-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="users-modal-title"
        tabIndex={-1}
      >
        <header className="users-modal__header">
          <div>
            <p className="users-modal__eyebrow">内镜中心 · 用户管理</p>
            <h2 id="users-modal-title">用户管理</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭用户管理" onClick={requestClose}>
            ×
          </button>
        </header>

        <div className="users-modal__notice">
          <span aria-hidden="true">i</span>
          <p>本次不提供科室范围限制，所有账号默认可见全院数据。密码由管理员设置后请线下告知本人。</p>
        </div>

        <form
          className="users-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAppliedFilters(filters);
          }}
        >
          <label>
            账号/显示名
            <input
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder="搜索账号或显示名"
            />
          </label>
          <label>
            状态
            <select
              value={filters.isActive}
              onChange={(event) =>
                setFilters({ ...filters, isActive: event.target.value as Filters['isActive'] })
              }
            >
              <option value="">全部状态</option>
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </label>
          <div className="users-filters__actions">
            <button className="button button--primary" type="submit">
              查询
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
                setAppliedFilters(EMPTY_FILTERS);
              }}
            >
              重置
            </button>
          </div>
        </form>

        <div className="users-toolbar">
          <p>
            共 <strong>{total}</strong> 个账号
          </p>
          <div>
            <button className="button button--primary" type="button" onClick={openCreate}>
              新建账号
            </button>
          </div>
        </div>

        {error && (
          <div className="feedback feedback--error" role="alert">
            {error}
            <button type="button" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {notice && (
          <div className="feedback feedback--success" role="status">
            {notice}
          </div>
        )}

        <div className="users-content">
          <div className="users-table-wrap">
            {loading ? (
              <div className="rules-state">正在加载账号列表…</div>
            ) : error && users.length === 0 ? (
              <div className="rules-state">
                <p>账号加载失败</p>
                <button className="button" type="button" onClick={() => void load()}>
                  重新加载
                </button>
              </div>
            ) : users.length === 0 ? (
              <div className="rules-state">
                <p>没有符合条件的账号</p>
                <span>调整筛选条件，或新建第一个账号。</span>
              </div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>显示名</th>
                    <th>状态</th>
                    <th>角色</th>
                    <th>患者详情</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.username}>
                      <td>
                        <strong>{user.username}</strong>
                      </td>
                      <td>{user.displayName}</td>
                      <td>
                        <span className={user.isActive ? 'status status--on' : 'status'}>
                          {user.isActive ? '启用' : '停用'}
                        </span>
                      </td>
                      <td>
                        {user.roles === null || user.roles.length === 0 ? (
                          <span className="readonly-label">未授权</span>
                        ) : (
                          <span className="users-roles">
                            {user.roles.map((role) => ROLE_LABELS[role]).join('、')}
                          </span>
                        )}
                      </td>
                      <td>{user.patientDetail ? '不脱敏' : '脱敏'}</td>
                      <td className="users-table__time">{new Date(user.createdAt).toLocaleString('zh-CN')}</td>
                      <td>
                        <div className="table-actions">
                          <button type="button" onClick={() => void openAccess(user)}>
                            授权
                          </button>
                          <button type="button" onClick={() => openPassword(user)}>
                            重置密码
                          </button>
                          <button
                            type="button"
                            aria-label={`${user.isActive ? '停用' : '启用'}账号 ${user.username}`}
                            disabled={statusBusy === user.username}
                            onClick={() => void toggleStatus(user)}
                          >
                            {user.isActive ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            className="table-actions__danger"
                            onClick={() => setDeleteTarget(user)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!loading && total > 0 && (
              <nav className="rules-pagination" aria-label="账号分页">
                <button
                  className="button"
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  上一页
                </button>
                <span>
                  第 {page} / {pageCount} 页
                </span>
                <button
                  className="button"
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  下一页
                </button>
              </nav>
            )}
          </div>

          {creating && (
            <aside className="rule-editor" aria-label="新建账号表单">
              <div className="panel-heading">
                <div>
                  <p>NEW ACCOUNT</p>
                  <h3>新建账号</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭新建账号表单"
                  onClick={closeEditors}
                >
                  ×
                </button>
              </div>
              <label>
                账号
                <input
                  autoFocus
                  value={createDraft.username}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, username: event.target.value });
                    setDirty(true);
                  }}
                  maxLength={50}
                  placeholder="登录用账号，字母数字"
                />
              </label>
              <label>
                显示名
                <input
                  value={createDraft.displayName}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, displayName: event.target.value });
                    setDirty(true);
                  }}
                  maxLength={100}
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={createDraft.password}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, password: event.target.value });
                    setDirty(true);
                  }}
                  minLength={8}
                  placeholder="至少 8 位"
                />
              </label>
              <label>
                确认密码
                <input
                  type="password"
                  value={createDraft.confirmPassword}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, confirmPassword: event.target.value });
                    setDirty(true);
                  }}
                  minLength={8}
                />
              </label>
              <div className="panel-actions">
                <button className="button" type="button" onClick={closeEditors}>
                  取消
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={createSaving}
                  onClick={() => void saveCreate()}
                >
                  {createSaving ? '保存中…' : '保存并分配角色'}
                </button>
              </div>
            </aside>
          )}

          {accessTarget && (
            <aside className="rule-editor" aria-label="账号授权表单">
              <div className="panel-heading">
                <div>
                  <p>ACCESS · {accessTarget.username}</p>
                  <h3>分配角色</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭授权表单"
                  onClick={closeEditors}
                >
                  ×
                </button>
              </div>
              {accessLoading ? (
                <div className="rules-state">正在加载授权…</div>
              ) : (
                <>
                  <div className="users-role-list">
                    {ALL_ROLES.map((role) => (
                      <label key={role} className="switch-row">
                        <input
                          type="checkbox"
                          checked={accessDraft.roles.includes(role)}
                          onChange={() => toggleRole(role)}
                        />
                        <span>{ROLE_LABELS[role]}</span>
                      </label>
                    ))}
                  </div>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={accessDraft.patientDetail}
                      onChange={(event) => {
                        setAccessDraft({ ...accessDraft, patientDetail: event.target.checked });
                        setDirty(true);
                      }}
                    />
                    <span>患者详情不脱敏</span>
                  </label>
                  {accessDraft.roles.length === 0 && (
                    <div className="users-warning" role="alert">
                      未选择任何角色：保存后该账号登录仍可成功，但角色受限接口全部 403。
                    </div>
                  )}
                  <div className="users-warning users-warning--info">
                    保存后该账号将拥有全院数据的访问范围（本次不支持按科室限制）。
                  </div>
                  <div className="panel-actions">
                    <button className="button" type="button" onClick={closeEditors}>
                      取消
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={accessSaving}
                      onClick={() => void saveAccess()}
                    >
                      {accessSaving ? '保存中…' : '保存授权'}
                    </button>
                  </div>
                </>
              )}
            </aside>
          )}

          {passwordTarget && (
            <aside className="rule-editor" aria-label="重置密码表单">
              <div className="panel-heading">
                <div>
                  <p>RESET PASSWORD · {passwordTarget.username}</p>
                  <h3>重置密码</h3>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭重置密码表单"
                  onClick={() => setPasswordTarget(null)}
                >
                  ×
                </button>
              </div>
              <label>
                新密码
                <input
                  autoFocus
                  type="password"
                  value={passwordDraft.newPassword}
                  onChange={(event) =>
                    setPasswordDraft({ ...passwordDraft, newPassword: event.target.value })
                  }
                  minLength={8}
                  placeholder="至少 8 位"
                />
              </label>
              <label>
                确认新密码
                <input
                  type="password"
                  value={passwordDraft.confirmPassword}
                  onChange={(event) =>
                    setPasswordDraft({ ...passwordDraft, confirmPassword: event.target.value })
                  }
                  minLength={8}
                />
              </label>
              <div className="panel-actions">
                <button className="button" type="button" onClick={() => setPasswordTarget(null)}>
                  取消
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={passwordSaving}
                  onClick={() => void savePassword()}
                >
                  {passwordSaving ? '保存中…' : '重置密码'}
                </button>
              </div>
            </aside>
          )}
        </div>
      </section>

      {deleteTarget && (
        <div
          className="users-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleteBusy) setDeleteTarget(null);
          }}
        >
          <div className="users-confirm" role="alertdialog" aria-modal="true" aria-labelledby="users-delete-title">
            <h3 id="users-delete-title">删除账号</h3>
            <p>
              确定删除账号 <strong>{deleteTarget.username}</strong>（{deleteTarget.displayName}）吗？
              该操作不可恢复，账号及其授权记录将被永久删除。
            </p>
            <div className="panel-actions">
              <button className="button" type="button" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
