#!/usr/bin/env python3
"""
TankerTrack local server — this computer acts as the shared backend.

Serves the manager website + driver app AND a small JSON API that both clients
read/write, so a trip scheduled on the manager PC shows up on a driver's phone
and everything the driver logs flows back. All data (trips, maintenance, fuel,
breakdowns, trip sheets) is stored on THIS computer in data/store.json.

Pure standard library — no Node, no Docker, no external packages (all of which
are unavailable/blocked on this machine). For production scale the same data
belongs in PostgreSQL (see apps/api + db/migrations), but this runs today.

Run:
    py server.py                 # serves on http://0.0.0.0:8000
    set PORT=9000 && py server.py # different port

Phones on the same Wi-Fi reach it at  http://<this-pc-lan-ip>:8000/driver.html
"""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
DATA_FILE = os.path.join(DATA_DIR, 'store.json')
os.makedirs(DATA_DIR, exist_ok=True)

_lock = threading.Lock()

# Only these paths are served as static files — the rest of the project
# directory (source, .git, docs) is NOT exposed on the network.
STATIC_ALLOW = {
    '/index.html', '/driver.html', '/tms-app.html', '/store.js',
    '/manifest.webmanifest', '/icon.svg', '/favicon.ico',
}


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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    # No-cache everything so store.js / HTML edits are always picked up.
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

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/store':
            return self._json(read_store())
        if path == '/api/rev':
            return self._json({'rev': read_store().get('rev', 0)})
        if path == '/':
            self.path = '/index.html'
            return super().do_GET()
        if path in STATIC_ALLOW:
            return super().do_GET()
        self.send_error(404)

    def do_PUT(self):
        if self.path.split('?')[0] == '/api/store':
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'null'
            try:
                state = json.loads(raw)
            except Exception:
                return self._json({'error': 'invalid json'}, 400)
            return self._json({'rev': write_store(state)})
        self.send_error(405)

    def log_message(self, fmt, *args):
        pass  # quiet


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    httpd = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print(f'TankerTrack server running on http://0.0.0.0:{port}')
    print(f'  data stored at: {DATA_FILE}')
    print('  press Ctrl+C to stop')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
