// Beta auth + credits client (spec §12). Vanilla PKCE flow against Supabase
// GoTrue: no SDK in the browser, the same idiom as signal-desk.js. When the
// server reports authRequired=false (/api/config), the gate never shows and
// every helper degrades to a no-op, so local dev behaves exactly as before.
//
// Exposes:
//   window.sdAuthReady  — promise, resolves when auth state is settled
//   window.sdAuth       — { enabled, token(), profile, signIn(), signOut(), refreshMe() }
//   window.setCredits   — ({credits, cap}) → updates the sidebar credit UI
//   window.flashNote    — (msg) → transient floating notice

(() => {
  const STORE = 'sd-session';
  const POST_LOGIN = 'sd-post-login';
  const VERIFIER = 'sd-pkce-verifier';

  let cfg = { authRequired: false, supabaseUrl: null, supabaseAnonKey: null };
  let session = null; // {access_token, refresh_token, expires_at (sec), email}
  let refreshing = null; // single-flight refresh promise

  const $ = (id) => document.getElementById(id);

  // ---- tiny UI helpers -------------------------------------------------------
  window.flashNote = (msg) => {
    document.querySelector('.flash-note')?.remove();
    const d = document.createElement('div');
    d.className = 'flash-note';
    d.setAttribute('role', 'status');
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  };

  window.setCredits = (o) => {
    if (!o || o.credits == null) return;
    const line = `${o.credits}${o.cap != null ? '/' + o.cap : ''}`;
    const pill = $('creditPill');
    if (pill) {
      pill.textContent = line;
      pill.title = `${o.credits} credit${o.credits === 1 ? '' : 's'} left today`;
      pill.hidden = false;
    }
    const val = $('creditsVal');
    if (val)
      val.textContent =
        'A search costs 1 credit and a PDF report download costs 1 credit. Credits refresh daily.';
    const meter = $('creditMeter');
    if (meter && o.cap != null && o.cap > 0) {
      meter.hidden = false;
      const pct = Math.max(0, Math.min(100, (o.credits / o.cap) * 100));
      const fill = $('creditFill');
      if (fill) fill.style.width = pct + '%';
      const label = $('creditLabel');
      if (label) label.textContent = `${line} available today`;
    }
  };

  const authReadyMark = () => {
    document.documentElement.dataset.auth = 'ready';
  };

  // The gate is a modal dialog (role=dialog, aria-modal in the markup): while
  // it is open the rest of the page is inert (no focus, no screen reader
  // access), Tab cycles inside it, and Escape closes it (accessibility QA
  // 2026-10). Closing leaves the signed-out app usable (e2e R3): a "Sign in"
  // button in the sidebar and the mobile bar takes the focus and reopens the
  // dialog, and any action that needs an account (a 401) reopens it too.
  let gateReturnFocus = null;
  let gateInerted = [];
  const gateFocusables = (gate) =>
    [...gate.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hidden && el.offsetParent !== null,
    );
  const signInButtons = () => [$('sideSignIn'), $('mbSignIn')].filter(Boolean);
  const setSignedOutUi = (signedOut) => signInButtons().forEach((b) => (b.hidden = !signedOut));
  // The sign-in button the user can actually see: the mobile bar's on small
  // screens (the sidebar is off-canvas there), the sidebar's otherwise.
  const visibleSignInButton = () =>
    signInButtons().find((b) => {
      if (b.hidden) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
    }) || null;
  const onGateKey = (e) => {
    const gate = $('authGate');
    if (!gate || gate.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hideGate({ dismissed: true });
      return;
    }
    if (e.key !== 'Tab') return;
    const items = gateFocusables(gate);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!gate.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const showGate = (errMsg) => {
    const gate = $('authGate');
    // Every path here is signed out: the sign-in buttons stay available
    // behind the dialog for when it is dismissed.
    setSignedOutUi(true);
    if (gate && gate.hidden) {
      gateReturnFocus = document.activeElement;
      gate.hidden = false;
      // Everything else on the page becomes inert while the dialog is open.
      // Only on opening: a second call must not lose the list to restore.
      gateInerted = [...(gate.parentElement?.children ?? [])].filter((el) => el !== gate && !el.inert);
      gateInerted.forEach((el) => (el.inert = true));
      document.addEventListener('keydown', onGateKey);
    }
    const err = $('authErr');
    if (err) {
      err.textContent = errMsg || '';
      err.hidden = !errMsg;
    }
    authReadyMark();
    if (gate) gateFocusables(gate)[0]?.focus();
  };

  /** Close the dialog. `dismissed` = the user closed it while signed out
   * (Escape): focus goes to the visible sign-in button, never to the hidden
   * dialog or the page body. Otherwise (a valid session) the sign-in buttons
   * go away and focus returns to where it was. */
  const hideGate = ({ dismissed = false } = {}) => {
    const gate = $('authGate');
    if (gate) gate.hidden = true;
    gateInerted.forEach((el) => (el.inert = false));
    gateInerted = [];
    document.removeEventListener('keydown', onGateKey);
    setSignedOutUi(dismissed);
    const back = dismissed
      ? visibleSignInButton() || $('doc')
      : gateReturnFocus && gateReturnFocus !== document.body && document.contains(gateReturnFocus)
        ? gateReturnFocus
        : null;
    back?.focus();
    gateReturnFocus = null;
    authReadyMark();
  };

  // ---- session persistence ---------------------------------------------------
  const loadSession = () => {
    try {
      const raw = localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const saveSession = (s) => {
    session = s;
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify(s));
      else localStorage.removeItem(STORE);
    } catch {}
  };

  const fromTokenResponse = (j) => ({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    // expires_at (sec epoch) is authoritative when present; else derive.
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    email: j.user?.email || session?.email || '',
  });

  // ---- GoTrue REST -----------------------------------------------------------
  const authUrl = (path) => `${cfg.supabaseUrl}/auth/v1${path}`;
  const authHeaders = () => ({ apikey: cfg.supabaseAnonKey, 'content-type': 'application/json' });

  async function exchangeCode(code) {
    const verifier = localStorage.getItem(VERIFIER) || '';
    const res = await fetch(authUrl('/token?grant_type=pkce'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    });
    localStorage.removeItem(VERIFIER);
    if (!res.ok) throw new Error('Sign-in failed. Please try again.');
    saveSession(fromTokenResponse(await res.json()));
  }

  async function refreshSession() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const rt = session?.refresh_token;
      if (!rt) throw new Error('no refresh token');
      const res = await fetch(authUrl('/token?grant_type=refresh_token'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) throw new Error('refresh failed');
      saveSession(fromTokenResponse(await res.json()));
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function token() {
    if (!cfg.authRequired) return null;
    if (!session) return null;
    if (session.expires_at - Date.now() / 1000 < 60) {
      try {
        await refreshSession();
      } catch {
        saveSession(null);
        showGate('Your session expired. Sign in again.');
        return null;
      }
    }
    return session.access_token;
  }

  // ---- PKCE sign-in ----------------------------------------------------------
  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  async function signIn() {
    try {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const rnd = crypto.getRandomValues(new Uint8Array(64));
      const verifier = Array.from(rnd, (b) => chars[b % chars.length]).join('');
      localStorage.setItem(VERIFIER, verifier);
      // Send the user back to the root; a deep entry point (/admin) is restored
      // after the exchange so only the site URL needs allow-listing in Supabase.
      if (location.pathname !== '/') localStorage.setItem(POST_LOGIN, location.pathname);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const q = new URLSearchParams({
        provider: 'google',
        redirect_to: location.origin + '/',
        code_challenge: b64url(digest),
        code_challenge_method: 's256',
      });
      location.href = authUrl('/authorize?' + q.toString());
    } catch (err) {
      showGate('Could not start sign-in: ' + err.message);
    }
  }

  async function signOut() {
    const t = session?.access_token;
    saveSession(null);
    if (t) {
      try {
        await fetch(authUrl('/logout'), {
          method: 'POST',
          headers: { ...authHeaders(), authorization: 'Bearer ' + t },
        });
      } catch {}
    }
    location.replace('/');
  }

  // ---- profile → sidebar -----------------------------------------------------
  async function refreshMe() {
    const t = await token();
    if (!t) return null;
    const res = await fetch('/api/me', { headers: { authorization: 'Bearer ' + t } });
    if (!res.ok) return null;
    const me = await res.json();
    window.sdAuth.profile = me;
    const row = $('sideUser');
    if (row) row.hidden = false;
    const em = $('userEmail');
    if (em) em.textContent = me.email || '';
    const ini = $('userInitial');
    if (ini) ini.textContent = (me.email || '?')[0].toUpperCase();
    window.setCredits(me);
    // Recents are per account (2026-07-14): hand the email to signal-desk.js
    // so it swaps to (and, first time, migrates onto) the user-scoped key.
    if (me.email) {
      for (let i = 0; i < 20 && !window.sdSetRecentsUser; i++)
        await new Promise((r) => setTimeout(r, 100));
      window.sdSetRecentsUser?.(me.email);
    }
    const acct = $('acctLine');
    if (acct && me.email) acct.textContent = `Signed in with Google as ${me.email}.`;
    const so = $('signOutBtn');
    if (so) so.hidden = false;
    const ad = $('adminLink');
    if (ad) ad.hidden = !me.isAdmin;
    // X link status (spec §14): the Settings row only shows where accounts do.
    const xr = $('xRow');
    if (xr) xr.hidden = false;
    const xl = $('xLine');
    if (xl)
      xl.textContent = me.xHandle
        ? `Linked to @${me.xHandle}.`
        : 'Link your X account to use the SyntheTick bot on X.';
    const xc = $('xConnectBtn');
    if (xc) xc.hidden = Boolean(me.xHandle);
    const xd = $('xDisconnectBtn');
    if (xd) xd.hidden = !me.xHandle;
    return me;
  }

  // ---- X account linking (spec §14) ------------------------------------------
  async function connectX() {
    const t = await token();
    if (!t) return;
    try {
      const res = await fetch('/api/x/link', { headers: { authorization: 'Bearer ' + t } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'X linking is unavailable right now.');
      location.assign(data.url);
    } catch (err) {
      window.flashNote(err.message || 'X linking is unavailable right now.');
    }
  }

  async function disconnectX() {
    const t = await token();
    if (!t) return;
    try {
      const res = await fetch('/api/x/unlink', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + t },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not disconnect the X account.');
      }
      window.flashNote('X account disconnected.');
      await refreshMe().catch(() => {});
    } catch (err) {
      window.flashNote(err.message || 'Could not disconnect the X account.');
    }
  }

  // ---- boot ------------------------------------------------------------------
  window.sdAuth = {
    enabled: false,
    profile: null,
    token,
    signIn,
    signOut,
    refreshMe,
    // Reopen the sign-in dialog (signal-desk.js calls it on a 401); a no-op
    // where sign-in is not required.
    showGate: () => {
      if (cfg.authRequired) showGate();
    },
  };

  window.sdAuthReady = (async () => {
    try {
      const res = await fetch('/api/config');
      cfg = await res.json();
    } catch {
      // Config unreachable: fail open so a broken auth setup never bricks dev.
      cfg = { authRequired: false };
    }
    window.sdAuth.enabled = Boolean(cfg.authRequired);
    if (!cfg.authRequired) {
      authReadyMark();
      return;
    }

    $('googleSignIn')?.addEventListener('click', signIn);
    for (const b of signInButtons()) b.addEventListener('click', () => showGate());
    $('signOutBtn')?.addEventListener('click', signOut);
    $('xConnectBtn')?.addEventListener('click', connectX);
    $('xDisconnectBtn')?.addEventListener('click', disconnectX);

    // X-link outcome? /api/x/callback lands back here as /?x=… (spec §14).
    const xOutcome = new URLSearchParams(location.search).get('x');
    if (xOutcome) {
      history.replaceState(null, '', location.pathname);
      window.flashNote(
        {
          linked: 'X account linked.',
          taken: 'That X account is already linked to another SyntheTick account.',
          denied: 'X linking was cancelled.',
        }[xOutcome] || 'X linking failed. Try again.',
      );
    }

    // OAuth callback? Exchange the code, then clean the URL.
    const code = new URLSearchParams(location.search).get('code');
    if (code) {
      try {
        await exchangeCode(code);
        history.replaceState(null, '', location.pathname);
        const dest = localStorage.getItem(POST_LOGIN);
        localStorage.removeItem(POST_LOGIN);
        if (dest && dest !== location.pathname) {
          location.replace(dest);
          return;
        }
      } catch (err) {
        history.replaceState(null, '', location.pathname);
        showGate(err.message);
        return;
      }
    } else {
      session = loadSession();
    }

    if (!session) {
      showGate();
      return;
    }
    // Validate/refresh, then load the profile. An invalid stored session shows
    // the gate from inside token().
    const t = await token();
    if (!t) return;
    hideGate();
    await refreshMe().catch(() => {});
  })();
})();
