/* ============================================================================
   TankerTrack — shared data layer
   ----------------------------------------------------------------------------
   Stands in for the real API + PostgreSQL until the backend is wired up. Both
   clients — the manager website (tms-app.html) and the driver app
   (driver.html) — load this file and read/write ONE shared store, so a trip the
   manager schedules is visible to the driver and a trip the driver completes is
   visible to the manager.

   The persistence is localStorage today; this is the exact seam where real
   `fetch()` calls to `/api/v1/...` slot in later. Same shape, same operations.

   Cross-tab: the browser fires a `storage` event in OTHER tabs when the store
   changes, so the two clients stay live without polling.
   ========================================================================== */
const TankerStore = (function () {
  const KEY = 'tankertrack.v1';

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  }

  return {
    /** Whole-store snapshot, or null if nothing has been saved yet. */
    load() { return read(); },

    /**
     * Persist a whole-store snapshot: { trips:[], fuelLog:[], maintenance:[],
     * seqs:{} }. Object URLs and File handles are per-session and meaningless
     * across a reload or another tab, so they are dropped on the way out — bill
     * *names* survive, the blobs do not (a known prototype limitation).
     */
    save(state) {
      localStorage.setItem(KEY, JSON.stringify(state, (k, v) =>
        (k === 'billUrl' || k === 'billFile') ? undefined : v));
    },

    clear() { localStorage.removeItem(KEY); },

    /** Fires with the fresh snapshot when the OTHER client writes. */
    onExternalChange(fn) {
      window.addEventListener('storage', (e) => {
        if (e.key === KEY && e.newValue) {
          try { fn(JSON.parse(e.newValue)); } catch { /* ignore */ }
        }
      });
    },
  };
})();
