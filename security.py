"""Small, dependency-free security helpers: rate limiting, CSRF tokens, security headers."""
import hmac
import secrets
import threading
import time
from collections import deque


class RateLimiter:
    """Sliding-window limiter keyed by any string (IP, table token, email...)."""

    def __init__(self, limit, window_seconds):
        self.limit = limit
        self.window = window_seconds
        self._hits = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def hit(self, key):
        """Record an attempt. Returns True if allowed, False if over the limit."""
        now = time.monotonic()
        with self._lock:
            if now - self._last_sweep > 300:
                self._sweep(now)
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def retry_after(self, key):
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            return max(0, int(self.window - (time.monotonic() - q[0])) + 1)

    def reset(self, key):
        with self._lock:
            self._hits.pop(key, None)

    def _sweep(self, now):
        for k in [k for k, q in self._hits.items() if not q or now - q[-1] > self.window]:
            del self._hits[k]
        self._last_sweep = now


def new_csrf():
    return secrets.token_urlsafe(24)


def csrf_ok(expected, given):
    return bool(expected) and bool(given) and hmac.compare_digest(str(expected), str(given))


CSP = (
    "default-src 'self'; "
    "img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "script-src 'self'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


def apply_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if resp.mimetype == "text/html":
        resp.headers.setdefault("Content-Security-Policy", CSP)
    return resp
