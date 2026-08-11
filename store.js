/* ============================================================================
   TankerTrack — shared data layer
   ----------------------------------------------------------------------------
   Both clients (manager website + driver app) load this file and read/write ONE
   shared store, so a trip scheduled on the manager PC shows up on a driver's
   phone and everything the driver logs flows back.

   Two modes, chosen automatically at startup:
     • SERVER mode  — when served by server.py, the store is the computer's
                      /api/store (persisted to data/store.json). This is what
                      connects the manager PC and the driver phones together.
                      Cross-device changes arrive via short polling.
     • LOCAL mode   — if no server is reachable (e.g. opened as a plain static
                      file), it falls back to localStorage, same as before.

   The clients call load()/save()/onExternalChange() exactly as before — this is
   the seam. Swapping localStorage for the API changed nothing in the UIs.
   ========================================================================== */
const TankerStore = (function () {
  const KEY = 'tankertrack.v1';
  // Token key is scoped to the app's role (set via window.TANKER_ROLE before this
  // script loads), so a DRIVER's token can never satisfy the MANAGER console's
  // gate — opening /tms-app.html with only a driver session still shows the
  // manager password prompt.
  const ROLE = (typeof window !== 'undefined' && window.TANKER_ROLE) ? window.TANKER_ROLE : 'default';
  const TOKEN_KEY = 'tankertrack.token.' + ROLE;
  const API = '/api/store';
  const REV = '/api/rev';
  const LOGIN = '/api/login';
  const LOGOUT = '/api/logout';

  let serverOk = false;
  let lastRev = -1;
  let polling = false;
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY) || null; } catch { /* private mode */ }

  // Attach the bearer token (if we have one) to a headers object.
  function withAuth(h) { h = h || {}; if (token) h['Authorization'] = 'Bearer ' + token; return h; }
  function clearToken() { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch {} }

  // Object URLs / File handles are per-session and meaningless once stored, so
  // they are stripped on the way out — bill/GRN/quote *names* survive, the blobs
  // do not (a known prototype limitation; real files belong in object storage).
  const drop = (k, v) =>
    (k === 'billUrl' || k === 'billFile' || k === 'grnUrl' || k === 'quoteUrl') ? undefined : v;

  function readCache() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  }
  function writeCache(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state, drop)); } catch { /* quota */ }
  }

  /* Synchronous fetch at startup so the clients' existing synchronous init
     (const saved = TankerStore.load(); ...) keeps working. If the server has
     data, it wins over any local cache — so a fresh phone gets the PC's data
     instead of re-seeding. If there's no server, we fall back to the cache. */
  function loadSync() {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', API, false);
      if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
      x.send();
      if (x.status === 200) {
        const { rev, state } = JSON.parse(x.responseText);
        serverOk = true;
        lastRev = rev;
        if (state) { writeCache(state); return state; }
        return null;            // server reachable but empty → let caller seed
      }
      if (x.status === 401) {   // server is up but we're not logged in
        serverOk = true;
        clearToken();           // drop any stale token so the client shows login
        return null;
      }
    } catch (e) { /* no server */ }
    serverOk = false;
    return readCache();
  }

  return {
    /** Whole-store snapshot (server truth if available, else local cache). */
    load() { return loadSync(); },

    /** Persist a whole-store snapshot. Writes the local cache and, in server
        mode, PUTs it to the computer so other devices see it. */
    save(state) {
      writeCache(state);
      if (serverOk && token) {
        fetch(API, {
          method: 'PUT',
          headers: withAuth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(state, drop),
        }).then(r => r.ok ? r.json() : Promise.reject(r.status))
          .then(j => { if (j && j.rev != null) lastRev = j.rev; })
          .catch(() => { /* offline / not authed; cache still holds it */ });
      }
    },

    clear() {
      localStorage.removeItem(KEY);
      if (serverOk && token) {
        fetch(API, { method: 'PUT', headers: withAuth({ 'Content-Type': 'application/json' }), body: 'null' })
          .catch(() => {});
      }
    },

    /** Authenticate. payload = {id, password} for a driver, or
        {manager:true, password} for the manager. Resolves with the server's
        response ({token, role, driver?}); rejects with the HTTP status. */
    login(payload) {
      return fetch(LOGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(j => {
          token = j.token;
          try { localStorage.setItem(TOKEN_KEY, token); } catch {}
          serverOk = true; lastRev = -1;   // force a fresh pull on next poll
          return j;
        });
    },

    /** Drop the session (server-side + local). */
    logout() {
      const t = token;
      clearToken();
      if (t) fetch(LOGOUT, { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } }).catch(() => {});
    },

    /** True once we hold a session token. */
    hasToken() { return !!token; },

    /** Fires with the fresh snapshot when the store changes elsewhere — another
        browser tab (LOCAL mode) or another device (SERVER mode). */
    onExternalChange(fn) {
      // Same-origin, same-browser: the storage event (covers two tabs on one PC).
      window.addEventListener('storage', (e) => {
        if (e.key === KEY && e.newValue) { try { fn(JSON.parse(e.newValue)); } catch {} }
      });

      // Cross-device: poll the computer's revision; pull the full store on change.
      if (serverOk && !polling) {
        polling = true;
        setInterval(async () => {
          if (!token) return;   // not logged in → nothing to poll
          try {
            const r = await fetch(REV, { cache: 'no-store', headers: withAuth() });
            if (!r.ok) return;
            const { rev } = await r.json();
            if (rev > lastRev) {
              const r2 = await fetch(API, { cache: 'no-store', headers: withAuth() });
              if (!r2.ok) return;
              const { rev: rv, state } = await r2.json();
              lastRev = rv;
              if (state) { writeCache(state); fn(state); }
            }
          } catch { /* server briefly unreachable */ }
        }, 2500);
      }
    },

    /** True when connected to the computer's server (for a UI indicator). */
    isServerMode() { return serverOk; },
  };
})();
