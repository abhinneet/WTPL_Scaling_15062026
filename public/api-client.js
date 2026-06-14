/**
 * public/api-client.js
 *
 * Drop-in helper that the dashboard HTML can use for authenticated
 * fetches, downloads via signed URLs, and a safer logout.
 *
 * Loaded with: <script src="/api-client.js" defer></script>
 *
 * Exposes: window.MitraAPI
 */
(function () {
  const TOKEN_KEY = 'mitra_token';
  const REFRESH_KEY = 'mitra_refresh_token';
  const USER_KEY = 'mitra_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function getRefresh() { return localStorage.getItem(REFRESH_KEY) || ''; }

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  async function refresh() {
    const rt = getRefresh();
    if (!rt) throw new Error('No refresh token');
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) throw new Error('Refresh failed');
    const d = await res.json();
    if (d.token) localStorage.setItem(TOKEN_KEY, d.token);
    if (d.refresh_token) localStorage.setItem(REFRESH_KEY, d.refresh_token);
    return d.token;
  }

  /**
   * Fetch with auto-refresh-on-401. Identical signature to fetch().
   */
  async function api(url, init) {
    init = init || {};
    init.headers = authHeaders(init.headers);
    let res = await fetch(url, init);
    if (res.status === 401 && getRefresh()) {
      try {
        await refresh();
        init.headers = authHeaders(init.headers);
        res = await fetch(url, init);
      } catch (e) {
        logoutLocal();
      }
    }
    return res;
  }

  /**
   * Download a stored file via signed URL flow.
   *   await MitraAPI.download('/api/unity/assets/' + id + '/download', 'myfile.unitypackage');
   */
  async function download(signedUrlEndpoint, suggestedName) {
    const r = await api(signedUrlEndpoint);
    if (!r.ok) throw new Error('Could not get download URL');
    const { url } = await r.json();
    // Trigger browser download
    const a = document.createElement('a');
    a.href = url;
    if (suggestedName) a.download = suggestedName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }

  function logoutLocal() {
    // Clear only MITRA-owned keys (the original code did localStorage.clear())
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('mitra_') || k === 'token') localStorage.removeItem(k);
    });
    // Also call the server so the refresh-token family is revoked
    const rt = getRefresh();
    if (rt) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(()=>{});
    }
    location.replace('/login.html');
  }

  // ── Idle warning ─────────────────────────────────────────────────────────
  const IDLE_WARN_MS = 25 * 60 * 1000;   // 25 minutes
  const IDLE_KICK_MS = 30 * 60 * 1000;   // 30 minutes
  let lastActivity = Date.now();
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
  });
  setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > IDLE_KICK_MS) {
      logoutLocal();
    } else if (idle > IDLE_WARN_MS && !window.__mitraIdleWarned) {
      window.__mitraIdleWarned = true;
      try { alert('You will be logged out in ~5 minutes due to inactivity.'); } catch {}
    }
  }, 60000);

  window.MitraAPI = {
    api, fetch: api, authHeaders, refresh, download, logout: logoutLocal,
    getToken, getRefresh,
  };
})();
