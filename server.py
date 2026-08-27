#!/usr/bin/env python3
"""
TankerTrack local server — this computer acts as the shared backend.

Serves the manager website + driver app AND a small JSON API that both clients
read/write, so a trip scheduled on the manager PC shows up on a driver's phone
and everything the driver logs flows back. All data (trips, maintenance, fuel,
breakdowns, trip sheets) is stored on THIS computer in data/store.json.

SECURITY MODEL (added so the app can be exposed to the internet via a tunnel):
  - Static pages (driver app, manager console, store.js) are served openly, but
    they are inert shells until you log in.
  - Every DATA call (/api/store, /api/rev) requires a session TOKEN. No token =>
    401. So poking the URL over a public tunnel gets you nothing.
  - Two roles:
      * MANAGER — logs in with a manager password (see console output on first
        run, or set MANAGER_PASSWORD). Full read/write of the whole store.
      * DRIVER  — logs in with their roster id + password. Only ever RECEIVES
        their own trips (no roster, no other drivers, no maintenance) and their
        writes are MERGED into their own trips only — a driver cannot see or
        change the manager side or another driver's data, whatever they POST.
  - Changing the driver URL to /tms-app.html just loads a manager PASSWORD gate.

Pure standard library — no Node, no Docker, no external packages.

Run:
    python3 server.py                 # serves on http://0.0.0.0:8000
    PORT=9000 python3 server.py       # different port
    MANAGER_PASSWORD=... python3 server.py   # set the manager password explicitly

Phones on the same Wi-Fi reach it at  http://<this-pc-lan-ip>:8000/
"""
import json
import os
import re
import hashlib
import secrets
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
DATA_FILE = os.path.join(DATA_DIR, 'store.json')
AUTH_FILE = os.path.join(DATA_DIR, 'auth.json')
os.makedirs(DATA_DIR, exist_ok=True)

_lock = threading.Lock()

# token -> {'role': 'manager'} | {'role': 'driver', 'id': <driverId>, 'name': <name>}
# In memory: tokens are cleared on restart, so everyone re-logs in after a reboot.
TOKENS = {}

# The driver roster is seeded deterministically, identical to the clients'
# makeDriverId/makePin, so ids/pins match whatever the browser would produce.
DRIVERS = ['R. Naik', 'M. Iqbal', 'S. Reddy', 'P. Kumar', 'A. Shetty',
           'V. Gowda', 'N. Hegde', 'B. Patil', 'T. Rao', 'K. Fernandes']

# Only these paths are served as static files — source, .git and docs are NOT
# exposed on the network.
#
# NOTE: '/tms-app.html' is deliberately ABSENT. The manager console is not served
# at a guessable path at all; it lives only at /console/<secret> (see
# console_path()). Handing a driver the public URL therefore cannot expose the
# manager console — there is no manager page on the public paths to find.
STATIC_ALLOW = {
    '/index.html', '/driver.html', '/store.js',
    '/manifest.webmanifest', '/icon.svg', '/favicon.ico',
}


# ------------------------- store persistence -------------------------
def read_store():
    try:
        with open(DATA_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'rev': 0, 'state': None}


def write_store(state):
    """Atomic whole-store write with a bumped revision, under a lock."""
    with _lock:
        rev = read_store().get('rev', 0) + 1
        tmp = DATA_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'rev': rev, 'state': state}, f, ensure_ascii=False)
        os.replace(tmp, DATA_FILE)
        return rev


# ------------------------- roster + auth helpers -------------------------
def make_driver_id(name, taken):
    s = re.sub(r'[^a-z\s.]', ' ', str(name).lower())
    parts = [p for p in re.split(r'[\s.]+', s) if p]
    base = (parts[0][0] + parts[-1]) if len(parts) >= 2 else (parts[0] if parts else 'driver')
    base = re.sub(r'[^a-z0-9]', '', base) or 'driver'
    ident, n = base, 1
    while ident in taken:
        n += 1
        ident = base + str(n)
    return ident


def make_pin(seed):
    h = 0
    for ch in str(seed):
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return str(1000 + (h % 9000))


def seed_drivers_if_missing():
    """Make sure the store has a driver roster, so login works even before the
    manager console has ever been opened. No-op if a roster already exists."""
    box = read_store()
    state = box.get('state')
    if state and state.get('drivers'):
        return
    if not state:
        state = {'trips': [], 'fuelLog': [], 'maintenance': [], 'breakdowns': [],
                 'seqs': {'tripSeq': 4820, 'maintSeq': 1000, 'fuelSeq': 2000, 'bdSeq': 3000}}
    taken = set()
    roster = []
    for name in DRIVERS:
        ident = make_driver_id(name, taken)
        taken.add(ident)
        roster.append({'id': ident, 'name': name, 'password': make_pin(name + '|' + ident), 'phone': ''})
    state['drivers'] = roster
    write_store(state)


def _sha(pw):
    return hashlib.sha256(pw.encode('utf-8')).hexdigest()


def ensure_manager_password():
    """Return the plaintext ONLY when a new password is generated (so it can be
    printed once); otherwise None. MANAGER_PASSWORD env overrides."""
    auth = {}
    try:
        with open(AUTH_FILE, encoding='utf-8') as f:
            auth = json.load(f)
        if auth.get('manager') and not os.environ.get('MANAGER_PASSWORD'):
            return None
    except Exception:
        pass
    pw = os.environ.get('MANAGER_PASSWORD') or secrets.token_urlsafe(6)
    auth['manager'] = _sha(pw)          # merge — never clobber the console secret
    with open(AUTH_FILE, 'w', encoding='utf-8') as f:
        json.dump(auth, f)
    return pw


def console_path():
    """The secret URL segment the manager console is served at, e.g.
    /console/8fkQ2r… — persisted in auth.json so it survives restarts.
    MANAGER_PATH env overrides it. This is the FIRST of two locks: an outsider
    who only has the public (driver) URL cannot even find the console, and even
    with the URL they still face the manager password."""
    try:
        with open(AUTH_FILE, encoding='utf-8') as f:
            auth = json.load(f)
    except Exception:
        auth = {}
    if os.environ.get('MANAGER_PATH'):
        seg = os.environ['MANAGER_PATH'].strip('/')
    elif auth.get('console'):
        return auth['console']
    else:
        seg = secrets.token_urlsafe(12)
    auth['console'] = seg
    with open(AUTH_FILE, 'w', encoding='utf-8') as f:
        json.dump(auth, f)
    return seg


def manager_password_ok(pw):
    try:
        with open(AUTH_FILE, encoding='utf-8') as f:
            auth = json.load(f)
        return bool(pw) and _sha(pw) == auth.get('manager')
    except Exception:
        return False


def issue_token(principal):
    token = secrets.token_hex(16)
    TOKENS[token] = principal
    return token


# ------------------------- role-scoped views -------------------------
def driver_view(state, driver_id):
    """What a driver is allowed to SEE: only their own trips + the reference data
    the app needs. No other drivers, no roster passwords, no maintenance."""
    state = state or {}
    me = next((d for d in state.get('drivers', []) if d.get('id') == driver_id), None)
    me_public = {k: v for k, v in me.items() if k != 'password'} if me else None
    my_trips = [t for t in state.get('trips', []) if t.get('driverId') == driver_id]
    my_trip_ids = {t.get('id') for t in my_trips}
    my_bd = [b for b in state.get('breakdowns', []) if b.get('tripId') in my_trip_ids]
    return {
        'trips': my_trips,
        'fuelLog': state.get('fuelLog', []),      # odometer continuity; not sensitive
        'maintenance': [],                          # manager-only — withheld
        'breakdowns': my_bd,
        'drivers': [me_public] if me_public else [],
        'seqs': state.get('seqs', {}),
    }


def merge_driver_update(master, incoming, driver_id):
    """Apply ONLY a driver's own-trip changes onto the authoritative store.
    Anything else the client sent (roster, maintenance, other trips, manager
    breakdown decisions) is ignored — the master copy wins."""
    master = master or {}
    incoming = incoming or {}
    inc_trips = {t.get('id'): t for t in incoming.get('trips', []) if t.get('driverId') == driver_id}
    # Replace only the driver's own trips; keep everyone else's untouched.
    new_trips = []
    for t in master.get('trips', []):
        if t.get('driverId') == driver_id and t.get('id') in inc_trips:
            new_trips.append(inc_trips[t.get('id')])
        else:
            new_trips.append(t)
    master['trips'] = new_trips
    my_trip_ids = {t.get('id') for t in new_trips if t.get('driverId') == driver_id}

    # Breakdowns: a driver may raise a new PENDING request or mark an APPROVED one
    # repaired. They can never self-approve or edit the manager's decision/amount.
    m_bd = {b.get('id'): b for b in master.get('breakdowns', [])}
    for b in incoming.get('breakdowns', []):
        if b.get('tripId') not in my_trip_ids:
            continue
        bid = b.get('id')
        if bid in m_bd:
            cur = m_bd[bid]
            if cur.get('status') == 'approved' and b.get('status') == 'completed':
                cur['status'] = 'completed'
                cur['completedAt'] = b.get('completedAt')
        else:
            nb = dict(b)
            nb['status'] = 'pending'      # force — no self-approval
            nb['decision'] = None
            nb['completedAt'] = None
            m_bd[bid] = nb
    master['breakdowns'] = list(m_bd.values())

    # Fuel readings: append the driver's new readings for their own trips only.
    existing = {e.get('id') for e in master.get('fuelLog', [])}
    for e in incoming.get('fuelLog', []):
        if e.get('id') not in existing and e.get('source') in my_trip_ids:
            master.setdefault('fuelLog', []).append(e)

    # Bump the sequence counters a driver legitimately advances.
    ms = master.setdefault('seqs', {})
    isq = incoming.get('seqs', {})
    for k in ('fuelSeq', 'bdSeq'):
        if isq.get(k) is not None:
            ms[k] = max(ms.get(k, 0) or 0, isq.get(k) or 0)
    return master


# ------------------------- HTTP handler -------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _principal(self):
        """Return the auth principal for this request, or None."""
        h = self.headers.get('Authorization', '')
        if h.startswith('Bearer '):
            return TOKENS.get(h[7:].strip())
        return None

    def _body(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            return json.loads(raw or b'null')
        except Exception:
            return None

    # ---- GET: static files + authenticated data reads ----
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/store':
            p = self._principal()
            if not p:
                return self._json({'error': 'auth required'}, 401)
            box = read_store()
            if p['role'] == 'manager':
                return self._json(box)
            return self._json({'rev': box.get('rev', 0),
                               'state': driver_view(box.get('state'), p['id'])})
        if path == '/api/rev':
            if not self._principal():
                return self._json({'error': 'auth required'}, 401)
            return self._json({'rev': read_store().get('rev', 0)})
        # The manager console — served ONLY at its secret path. Compared in
        # constant time so the secret can't be recovered by timing the 404.
        if path.startswith('/console/'):
            seg = path[len('/console/'):].rstrip('/')
            if secrets.compare_digest(seg, CONSOLE_SEG):
                self.path = '/tms-app.html'
                return super().do_GET()
            return self.send_error(404)
        if path == '/':
            self.path = '/index.html'
            return super().do_GET()
        if path in STATIC_ALLOW:
            return super().do_GET()
        self.send_error(404)

    # ---- POST: login / logout ----
    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/login':
            data = self._body() or {}
            if data.get('manager'):
                if manager_password_ok(data.get('password', '')):
                    return self._json({'token': issue_token({'role': 'manager'}), 'role': 'manager'})
                return self._json({'error': 'invalid'}, 401)
            ident = str(data.get('id', '')).strip().lower()
            pw = str(data.get('password', ''))
            state = read_store().get('state') or {}
            d = next((x for x in state.get('drivers', []) if x.get('id') == ident), None)
            if d and str(d.get('password')) == pw:
                token = issue_token({'role': 'driver', 'id': d['id'], 'name': d.get('name')})
                return self._json({'token': token, 'role': 'driver',
                                   'driver': {'id': d['id'], 'name': d.get('name')}})
            return self._json({'error': 'invalid'}, 401)
        if path == '/api/logout':
            h = self.headers.get('Authorization', '')
            if h.startswith('Bearer '):
                TOKENS.pop(h[7:].strip(), None)
            return self._json({'ok': True})
        self.send_error(404)

    # ---- PUT: authenticated data writes (role-scoped) ----
    def do_PUT(self):
        if self.path.split('?')[0] != '/api/store':
            return self.send_error(405)
        p = self._principal()
        if not p:
            return self._json({'error': 'auth required'}, 401)
        incoming = self._body()
        if p['role'] == 'manager':
            return self._json({'rev': write_store(incoming)})
        # Driver: never replace the store — merge only their own trips.
        with _lock:
            master = read_store().get('state') or {}
            merged = merge_driver_update(master, incoming, p['id'])
        rev = write_store(merged)
        return self._json({'rev': rev, 'state': driver_view(merged, p['id'])})

    def log_message(self, fmt, *args):
        pass  # quiet


CONSOLE_SEG = ''   # set at startup from console_path()

if __name__ == '__main__':
    seed_drivers_if_missing()
    newpw = ensure_manager_password()
    CONSOLE_SEG = console_path()
    port = int(os.environ.get('PORT', '8000'))
    httpd = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print(f'TankerTrack server running on http://0.0.0.0:{port}')
    print(f'  data stored at: {DATA_FILE}')
    print('  ' + '=' * 60)
    print(f'  DRIVER  (public, hand this out):  /            → driver.html')
    print(f'  MANAGER (keep secret):            /console/{CONSOLE_SEG}')
    if newpw:
        print(f'  MANAGER PASSWORD (shown once):    {newpw}')
    else:
        print('  MANAGER PASSWORD:                 already set')
    print('  ' + '=' * 60)
    print('  The manager console exists ONLY at that secret path; /tms-app.html'
          ' now 404s, so the public URL cannot reach it.')
    print('  press Ctrl+C to stop', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
