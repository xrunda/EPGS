export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordVersion: number;
  isActive: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface SessionPayload {
  sub: string;
  username: string;
  passwordVersion: number;
}

export interface AuthUserStore {
  findByUsername(username: string): Promise<AuthUser | null>;
  findById(id: string): Promise<AuthUser | null>;
  updatePassword(id: string, passwordHash: string, expectedVersion: number): Promise<AuthUser>;
  create(username: string, displayName: string, passwordHash: string): Promise<AuthUser>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AuthTokenSigner {
  sign(payload: SessionPayload): string;
  verify(token: string): SessionPayload;
}

export const AUTH_USER_STORE = Symbol('AUTH_USER_STORE');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const AUTH_TOKEN_SIGNER = Symbol('AUTH_TOKEN_SIGNER');
export const AUTH_COOKIE_OPTIONS = Symbol('AUTH_COOKIE_OPTIONS');

export interface AuthCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}
