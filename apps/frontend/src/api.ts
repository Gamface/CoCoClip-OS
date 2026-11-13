export type { ApprovalRecord as Approval, AuditEntry, Company, FirewallEvent, WorkerState, WorkforceAgent as Agent } from "@agent-os/shared-types";

const TOKEN_KEY = "agent-os.operator-token";

/** Operator token + "the backend asked for one" flag, shared by every component (useSyncExternalStore). */
interface AuthState {
  token: string;
  /** Set when the backend answered 401: the UI shows the sign-in field. */
  required: boolean;
  /** Set when a token was present and the backend still answered 401. */
  rejected: boolean;
}
let auth: AuthState = { token: "", required: false, rejected: false };
let loaded = false;
const listeners = new Set<() => void>();

function emit(next: Partial<AuthState>) {
  auth = { ...auth, ...next };
  listeners.forEach((l) => l());
}

export function getAuth(): AuthState {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      auth = { ...auth, token: localStorage.getItem(TOKEN_KEY) ?? "" };
    } catch {
      /* storage unavailable */
    }
  }
  return auth;
}
const SERVER_AUTH: AuthState = { token: "", required: false, rejected: false };
export const getServerAuth = () => SERVER_AUTH;

export function subscribeAuth(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getToken(): string {
  return getAuth().token;
}

export function setToken(t: string) {
  const token = t.trim();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
  emit({ token, required: false, rejected: false });
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Error from api(); status 401 means the operator token is missing or wrong (the UI asks for it). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
export const isAuthError = (e: unknown) => e instanceof ApiError && e.status === 401;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Remember which token this request carried. On first load the panels fetch once before the saved
  // token is read from storage (server snapshot), then again with it; a late 401 from that first,
  // tokenless request must not flag the saved token as missing or rejected.
  const sent = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(sent ? { Authorization: `Bearer ${sent}` } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await res.json().catch(() => ({}));
  const current = sent === getToken();
  if (res.status === 401 && current) emit({ required: true, rejected: Boolean(sent) });
  // A request with the current token got through, so any earlier "token required" prompt is stale.
  if (res.status !== 401 && current && (auth.required || auth.rejected)) emit({ required: false, rejected: false });
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body as T;
}
