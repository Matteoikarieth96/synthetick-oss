'use client';

// Beta admin panel (spec §12): per-user daily caps, one-day credit grants and
// today's usage, for the ~20-person open beta. Server-side authorization only:
// every /api/admin call re-checks profiles.is_admin with the service role.
import Script from 'next/script';
import { useCallback, useEffect, useState } from 'react';

interface AdminUser {
  id: string;
  email: string;
  credits: number;
  daily_cap: number;
  is_admin: boolean;
  created_at: string;
  today: { searches: number; pdfs: number };
  api_keys: { active: number; created: number };
}

interface AdminPrompt {
  id: number;
  email: string;
  created_at: string;
  chars: number;
  prompt: string; // excerpt, first 2000 chars
}

type Gate = 'loading' | 'authOff' | 'signedOut' | 'notAdmin' | 'ready';

declare global {
  interface Window {
    sdAuthReady?: Promise<void>;
    sdAuth?: {
      enabled: boolean;
      token: () => Promise<string | null>;
      signIn: () => void;
      profile: { isAdmin?: boolean } | null;
    };
    flashNote?: (msg: string) => void;
  }
}

// sd-auth.js loads as a separate script: React can mount (and fire effects)
// before it has defined window.sdAuthReady. Poll briefly so the first admin
// call never races the auth bootstrap and misreads a live session as signed out.
async function sdReady() {
  for (let i = 0; i < 100 && !window.sdAuthReady; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await (window.sdAuthReady ?? Promise.resolve());
}

async function adminFetch(path: string, opts: RequestInit = {}) {
  await sdReady();
  const t = await window.sdAuth?.token();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (t) headers.authorization = 'Bearer ' + t;
  return fetch(path, { ...opts, headers });
}

function UserRow({ u, onAdjust }: { u: AdminUser; onAdjust: (userId: string, action: string, value: number) => Promise<void> }) {
  const [cap, setCap] = useState(String(u.daily_cap));
  const [grant, setGrant] = useState('5');
  const [busy, setBusy] = useState(false);
  const run = async (action: string, value: number) => {
    setBusy(true);
    try {
      await onAdjust(u.id, action, value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td className="ad-email">
        {u.email || u.id.slice(0, 8)}
        {u.is_admin ? <span className="ad-tag">admin</span> : null}
      </td>
      <td className="ad-num">
        {u.credits} / {u.daily_cap}
      </td>
      <td className="ad-num">
        {u.today.searches} searches, {u.today.pdfs} PDFs
      </td>
      <td className="ad-num">
        {u.api_keys.created === 0
          ? 'none'
          : `${u.api_keys.active} active of ${u.api_keys.created}`}
      </td>
      <td className="ad-num">{new Date(u.created_at).toLocaleDateString()}</td>
      <td className="ad-actions">
        <label>
          Cap
          <input
            type="number"
            min={0}
            max={1000}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          type="button"
          disabled={busy || Number(cap) === u.daily_cap}
          onClick={() => run('set_cap', Number(cap))}
        >
          Save cap
        </button>
        <label>
          Grant
          <input
            type="number"
            min={-1000}
            max={1000}
            value={grant}
            onChange={(e) => setGrant(e.target.value)}
            disabled={busy}
          />
        </label>
        <button type="button" disabled={busy || !Number(grant)} onClick={() => run('grant', Number(grant))}>
          Grant today
        </button>
        <button type="button" className="ad-danger" disabled={busy || u.credits === 0} onClick={() => run('set_credits', 0)}>
          Zero today
        </button>
      </td>
    </tr>
  );
}

export default function AdminPage() {
  const [gate, setGate] = useState<Gate>('loading');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState('');
  const [prompts, setPrompts] = useState<AdminPrompt[]>([]);
  const [promptsNote, setPromptsNote] = useState('');

  const load = useCallback(async () => {
    const res = await adminFetch('/api/admin/users');
    if (res.status === 503) return setGate('authOff');
    if (res.status === 401) return setGate('signedOut');
    if (res.status === 403) return setGate('notAdmin');
    if (!res.ok) {
      setErr('Could not load users (HTTP ' + res.status + ').');
      return setGate('ready');
    }
    const j = (await res.json()) as { users: AdminUser[] };
    setUsers(j.users);
    setErr('');
    setGate('ready');
    // Prompts load after the gate: a failure here only affects its own section.
    try {
      const pr = await adminFetch('/api/admin/prompts');
      if (pr.ok) {
        const pj = (await pr.json()) as { prompts: AdminPrompt[]; warning?: string };
        setPrompts(pj.prompts);
        setPromptsNote(pj.warning ?? '');
      } else setPromptsNote('Could not load prompts (HTTP ' + pr.status + ').');
    } catch {
      setPromptsNote('Could not load prompts.');
    }
  }, []);

  useEffect(() => {
    // sd-auth.js resolves auth state; only then is the token available.
    let alive = true;
    (async () => {
      await sdReady();
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const onAdjust = useCallback(
    async (userId: string, action: string, value: number) => {
      const res = await adminFetch('/api/admin/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, action, value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
        window.flashNote?.(j.error || 'Adjustment failed.');
        return;
      }
      await load();
    },
    [load],
  );

  const totalKeys = users.reduce((n, u) => n + u.api_keys.created, 0);

  return (
    <div className="admin-wrap">
      <Script src="/sd-auth.js" strategy="afterInteractive" />
      <header className="admin-head">
        <a className="admin-back" href="/">
          SyntheTick<span className="dot">.</span>
        </a>
        <h1>Beta admin</h1>
        <p>
          Daily credits per user. The cap is permanent and refills each day at midnight UTC; grants
          only add to today&apos;s balance and disappear at the next refresh.
        </p>
      </header>

      {gate === 'loading' && <p className="admin-note">Checking access…</p>}
      {gate === 'authOff' && (
        <p className="admin-note">
          Beta auth is not enabled on this server. Set SUPABASE_ANON_KEY and restart to use the
          admin panel.
        </p>
      )}
      {gate === 'signedOut' && (
        <p className="admin-note">
          You are signed out.{' '}
          <button type="button" className="sp-btn" onClick={() => window.sdAuth?.signIn()}>
            Sign in with Google
          </button>
        </p>
      )}
      {gate === 'notAdmin' && <p className="admin-note">This account does not have admin access.</p>}

      {gate === 'ready' && (
        <>
          {err && <p className="admin-note">{err}</p>}
          <div className="admin-tools">
            <span>
              {users.length} user{users.length === 1 ? '' : 's'}
            </span>
            <span>{totalKeys} API key{totalKeys === 1 ? '' : 's'} created</span>
            <button type="button" className="sp-btn" onClick={() => void load()}>
              Refresh
            </button>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Credits today</th>
                  <th>Used today</th>
                  <th>API keys</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} u={u} onAdjust={onAdjust} />
                ))}
                {!users.length && (
                  <tr>
                    <td colSpan={6} className="admin-note">
                      No users yet. Profiles appear here after the first Google sign-in.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h2 className="admin-sub">Recent prompts</h2>
          <p className="admin-note">
            The last {prompts.length || 100} research prompts submitted by users, newest first.
            Long prompts show their first 2,000 characters. Click one to expand it.
          </p>
          {promptsNote && <p className="admin-note">{promptsNote}</p>}
          {!promptsNote && !prompts.length && (
            <p className="admin-note">No prompts yet. They appear when a user starts a research.</p>
          )}
          {prompts.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Prompt</th>
                  </tr>
                </thead>
                <tbody>
                  {prompts.map((p) => (
                    <tr key={p.id}>
                      <td className="ad-num">{new Date(p.created_at).toLocaleString()}</td>
                      <td className="ad-email">{p.email}</td>
                      <td className="ad-prompt">
                        <details>
                          <summary>
                            {p.prompt.slice(0, 140)}
                            {p.chars > 140 ? '…' : ''}
                            <span className="ad-chars">{p.chars.toLocaleString()} chars</span>
                          </summary>
                          <pre>{p.prompt}{p.chars > 2000 ? '\n\n[truncated: showing the first 2,000 characters]' : ''}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
