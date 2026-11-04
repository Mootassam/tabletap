# TableTap — QR menu & table ordering for restaurants

Guests scan the QR code on their table, browse a beautiful menu on their phone, order and track it live.
The kitchen sees every order the second it's placed. The owner manages menu, tables, staff and sales.

## Start

Double-click **`Start.bat`** (installs requirements the first time), or:

```
pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:5080 → the setup screen creates your restaurant and owner account
(tick "demo menu" to get 22 dishes and 12 tables to play with).

## Screens

| Who | URL | What |
|---|---|---|
| Guest | `/t/<table-code>` (from the QR) | Menu, options & extras, cart, order, live status, call waiter, request bill. EN / FR / ES / AR (RTL). |
| Guest | `/r/<slug>` | Browse-only menu link for Instagram / Google / website. |
| Kitchen | `/kitchen` | Full-screen ticket board: New → Preparing → Ready, timers turn amber/red, sound alerts, "86" sold-out switch, print ticket. |
| Floor staff | `/admin#/live` | Live orders, waiter & bill calls, settle a whole table, mark paid cash/card. |
| Manager | `/admin` | Dashboard, menu editor (drag to reorder, photos, option groups, serving hours), tables & QR printing, order history + CSV, staff, settings. |
| You (platform owner) | `/admin#/platform` | Every restaurant you sell to: subscription dates, suspend/activate, extend, backups. |

Roles: **platform** (you) · **manager** · **waiter** · **kitchen** — each sees only what they need.

## Guests on mobile data (important)

By default QR codes point to this computer's **local network address** (e.g. `http://192.168.1.17:5080`),
so guests must be on the restaurant Wi-Fi. For guests on 4G/5G, TableTap must be reachable on the internet:

1. **Hosted (recommended for selling subscriptions):** run it on a small VPS behind Caddy/nginx with HTTPS
   ```
   TABLETAP_PUBLIC_URL=https://menu.yourdomain.com
   TABLETAP_TRUST_PROXY=1
   TABLETAP_SECURE_COOKIES=1
   python server.py
   ```
2. **From the restaurant PC:** a *named* Cloudflare Tunnel with your own domain (quick tunnels change URL on
   every restart, which would break printed QR codes).

Then set **Settings → Public link** and print the QR codes.

## Settings via environment

| Variable | Default | |
|---|---|---|
| `TABLETAP_PORT` | 5080 | |
| `TABLETAP_HOST` | 0.0.0.0 | listen on all interfaces so phones can connect |
| `TABLETAP_DATA` | `./data` | database, uploads, backups, log |
| `TABLETAP_PUBLIC_URL` | — | base URL printed in QR codes |
| `TABLETAP_TRUST_PROXY` | — | `1` behind nginx/Caddy |
| `TABLETAP_SECURE_COOKIES` | — | `1` when served over HTTPS |
| `TABLETAP_THREADS` | 48 | waitress worker threads (each open kitchen screen holds one while waiting) |

## Safety & robustness

- The server **re-prices every order** from the database — prices, options and quantities sent by a phone are never trusted.
- Required options, "pick one", "up to N", sold-out items and serving hours are enforced on the server.
- Table QR codes are random tokens (not `table=5`), and can be regenerated if a code is abused.
- Passwords hashed (scrypt), CSRF tokens on every write, rate limits on login / orders / waiter calls,
  strict Content-Security-Policy, uploads re-encoded to WebP (EXIF/GPS stripped, size-capped).
- Every restaurant's data is isolated; managers can't reach another restaurant's items, tables or QR codes.
- Money is stored as integer cents (no rounding drift); tax inclusive/exclusive + service charge supported.
- SQLite in WAL mode, atomic order numbering, automatic daily backups (last 14 kept) in `data/backups`.

## Tests

```
python -m unittest discover -s tests -v
```

34 end-to-end tests: price tampering, option rules, sold out, closed/expired restaurants, tax maths,
rate limits, roles & permissions, multi-restaurant isolation, uploads, QR/print pages, backups.
