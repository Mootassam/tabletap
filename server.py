"""TableTap - QR menu & table ordering for restaurants.

Run:  python server.py            (serves on 0.0.0.0:5080 so phones on the Wi-Fi can reach it)
Env:  TABLETAP_PORT, TABLETAP_HOST, TABLETAP_DATA, TABLETAP_PUBLIC_URL,
      TABLETAP_TRUST_PROXY=1 (behind nginx/Caddy), TABLETAP_SECURE_COOKIES=1 (HTTPS only)

Roles:
  platform  - you, the software owner: every restaurant, subscriptions, backups
  manager   - a restaurant owner/manager: menu, tables & QR, staff, reports, settings
  waiter    - live orders, payments, waiter calls
  kitchen   - kitchen display only
"""
import csv
import functools
import io
import json
import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone

from flask import (Flask, Response, abort, g, jsonify, redirect, render_template, request,
                   send_file, send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import app_paths
import db
import media
import security
import services as svc
from services import ServiceError

log = logging.getLogger("tabletap")

app = Flask(__name__, static_folder=app_paths.STATIC_DIR, template_folder=app_paths.TEMPLATE_DIR)
app.config.update(
    MAX_CONTENT_LENGTH=12 * 1024 * 1024,
    SESSION_COOKIE_NAME="tabletap_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("TABLETAP_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    JSON_SORT_KEYS=False,
    SEND_FILE_MAX_AGE_DEFAULT=0,
)
app.json.ensure_ascii = False
app.json.sort_keys = False

if os.environ.get("TABLETAP_TRUST_PROXY") == "1":
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _secret_key():
    try:
        with open(app_paths.SECRET_PATH, "rb") as f:
            key = f.read()
            if len(key) >= 32:
                return key
    except OSError:
        pass
    key = os.urandom(48)
    with open(app_paths.SECRET_PATH, "wb") as f:
        f.write(key)
    return key


app.secret_key = _secret_key()

ROLES = ("platform", "manager", "waiter", "kitchen")
STAFF_ROLES = ("manager", "waiter", "kitchen")
ASSET_VERSION = app_paths.APP_VERSION + "-" + str(int(time.time()))

login_limit_ip = security.RateLimiter(12, 600)
login_limit_email = security.RateLimiter(8, 900)
# Guests in one restaurant often share ONE public IP (the venue's Wi-Fi NAT), so per-IP limits are
# generous abuse guards; the per-table limit is the one that stops a prankster.
order_limit_table = security.RateLimiter(20, 600)
order_limit_ip = security.RateLimiter(150, 600)
call_limit_table = security.RateLimiter(6, 300)
public_read_limit = security.RateLimiter(1500, 60)


# ================================================================= plumbing

@app.before_request
def _load_user():
    g.user = None
    g.rest = None
    uid = session.get("uid")
    if uid:
        u = db.q1("SELECT * FROM users WHERE id = ? AND active = 1", (uid,))
        if u is None or session.get("pwv") != u["password_hash"][-12:]:
            session.clear()           # deleted, disabled, or password changed elsewhere
            return
        g.user = u
        rid = session.get("rid") if u["role"] == "platform" else u["restaurant_id"]
        if rid:
            g.rest = svc.get_restaurant(rid)
        if g.rest is None and u["role"] == "platform":
            first = db.q1("SELECT id FROM restaurants ORDER BY id LIMIT 1")
            if first:
                session["rid"] = first["id"]
                g.rest = svc.get_restaurant(first["id"])


@app.after_request
def _headers(resp):
    security.apply_headers(resp)
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(ServiceError)
def _service_error(e):
    return jsonify(e.to_json()), e.status


@app.errorhandler(media.MediaError)
def _media_error(e):
    return jsonify({"ok": False, "error": str(e), "code": "bad_image"}), 400


@app.errorhandler(413)
def _too_large(e):
    return jsonify({"ok": False, "error": "File too large (max 12 MB)", "code": "too_large"}), 413


@app.errorhandler(404)
def _not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Not found", "code": "not_found"}), 404
    return render_template("message.html", title="Page not found",
                           message="This link doesn't lead anywhere. If you scanned a table QR code, please ask a staff member.",
                           v=ASSET_VERSION), 404


@app.errorhandler(500)
def _server_error(e):
    log.exception("Unhandled error on %s", request.path)
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Something went wrong on our side. Please try again.", "code": "server"}), 500
    return render_template("message.html", title="Something went wrong",
                           message="Please try again in a moment.", v=ASSET_VERSION), 500


def client_ip():
    return request.remote_addr or ""


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def ok(**kw):
    kw.setdefault("ok", True)
    return jsonify(kw)


def api(roles=None, csrf=True, need_rest=True):
    """Decorator for JSON APIs behind login. Enforces role, CSRF (on writes) and restaurant scope."""
    roles = roles or ROLES

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            if g.user is None:
                return jsonify({"ok": False, "error": "Please sign in again", "code": "auth"}), 401
            if g.user["role"] not in roles:
                return jsonify({"ok": False, "error": "You don't have access to this", "code": "forbidden"}), 403
            if csrf and request.method not in ("GET", "HEAD", "OPTIONS"):
                if not security.csrf_ok(session.get("csrf"), request.headers.get("X-CSRF-Token")):
                    return jsonify({"ok": False, "error": "Session expired - reload the page", "code": "csrf"}), 403
            if need_rest and g.rest is None:
                return jsonify({"ok": False, "error": "No restaurant selected", "code": "no_restaurant"}), 400
            return fn(*a, **kw)
        return wrapper
    return deco


def page(roles):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            if not has_users():
                return redirect(url_for("setup_page"))
            if g.user is None:
                return redirect(url_for("login_page", next=request.path))
            if g.user["role"] not in roles:
                return redirect(home_for(g.user))
            return fn(*a, **kw)
        return wrapper
    return deco


def has_users():
    return db.q1("SELECT 1 FROM users LIMIT 1") is not None


def home_for(user):
    if user["role"] == "kitchen":
        return url_for("kitchen_page")
    if user["role"] == "waiter":
        return url_for("admin_page") + "#/live"
    return url_for("admin_page")


def csrf_token():
    if not session.get("csrf"):
        session["csrf"] = security.new_csrf()
    return session["csrf"]


def start_session(user, rid=None):
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    session["pwv"] = user["password_hash"][-12:]
    session["csrf"] = security.new_csrf()
    if user["role"] == "platform":
        session["rid"] = rid
    db.run("UPDATE users SET last_login = ? WHERE id = ?", (db.now(), user["id"]))


def boot_json(data):
    """JSON safe to embed inside <script type=application/json>."""
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def user_public(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]}


def audit(action, detail=""):
    db.audit(g.rest["id"] if g.rest else None, g.user["email"] if g.user else "", action, detail)


# ---------------------------------------------------------------- public URL / LAN

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))   # no packet is sent; just picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def public_base():
    """Base URL printed inside QR codes. Priority: env > saved setting > this request (with LAN IP
    instead of localhost, because a phone can't open 'localhost')."""
    env = os.environ.get("TABLETAP_PUBLIC_URL", "").strip()
    if env:
        return env.rstrip("/"), "env"
    row = db.q1("SELECT value FROM meta WHERE key = 'public_url'")
    if row and row["value"]:
        return row["value"].rstrip("/"), "custom"
    host = request.host
    hostname, _, port = host.partition(":")
    if hostname in ("127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"):
        host = lan_ip() + (":" + port if port else "")
        return "%s://%s" % (request.scheme, host), "lan"
    return request.host_url.rstrip("/"), "request"


def table_url(token):
    return public_base()[0] + "/t/" + token


# ================================================================= setup / auth pages

@app.route("/")
def index():
    if not has_users():
        return redirect(url_for("setup_page"))
    if g.user is None:
        return redirect(url_for("login_page"))
    return redirect(home_for(g.user))


@app.route("/setup", methods=["GET"])
def setup_page():
    if has_users():
        return redirect(url_for("login_page"))
    return render_template("setup.html", csrf=csrf_token(), v=ASSET_VERSION, currencies=CURRENCIES)


@app.route("/api/setup", methods=["POST"])
def api_setup():
    if has_users():
        return jsonify({"ok": False, "error": "Setup is already complete", "code": "done"}), 400
    if not security.csrf_ok(session.get("csrf"), request.headers.get("X-CSRF-Token")):
        return jsonify({"ok": False, "error": "Session expired - reload the page", "code": "csrf"}), 403
    d = body()
    rname = svc.clean_text(d.get("restaurant"), 80)
    name = svc.clean_text(d.get("name"), 80)
    email = svc.clean_text(d.get("email"), 120).lower()
    pw = str(d.get("password") or "")
    if not rname:
        raise ServiceError("Enter your restaurant's name", "field", field="restaurant")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ServiceError("Enter a valid email", "field", field="email")
    if len(pw) < 8:
        raise ServiceError("Password must be at least 8 characters", "field", field="password")
    cur = next((c for c in CURRENCIES if c["code"] == d.get("currency")), CURRENCIES[0])
    rid = svc.create_restaurant(
        rname, currency=cur["code"], currency_symbol=cur["symbol"],
        currency_suffix=1 if cur["suffix"] else 0, decimals=cur["decimals"],
        language=d.get("language") if d.get("language") in svc.LANGUAGES else "en")
    uid = db.run("INSERT INTO users(restaurant_id, email, name, role, password_hash, created_at) "
                 "VALUES(NULL,?,?,?,?,?)", (email, name, "platform", generate_password_hash(pw), db.now()))
    if d.get("demo"):
        import seed
        seed.demo_menu(rid)
    user = db.q1("SELECT * FROM users WHERE id = ?", (uid,))
    start_session(user, rid)
    db.audit(rid, email, "setup", rname)
    return ok(redirect=url_for("admin_page"))


@app.route("/login")
def login_page():
    if not has_users():
        return redirect(url_for("setup_page"))
    if g.user is not None:
        return redirect(home_for(g.user))
    return render_template("login.html", csrf=csrf_token(), v=ASSET_VERSION)


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    if not security.csrf_ok(session.get("csrf"), request.headers.get("X-CSRF-Token")):
        return jsonify({"ok": False, "error": "Session expired - reload the page", "code": "csrf"}), 403
    d = body()
    email = svc.clean_text(d.get("email"), 120).lower()
    ip = client_ip()
    if not login_limit_ip.hit(ip) or not login_limit_email.hit(email):
        wait = max(login_limit_ip.retry_after(ip), login_limit_email.retry_after(email))
        return jsonify({"ok": False, "error": "Too many attempts. Try again in %d min." % max(1, wait // 60),
                        "code": "rate"}), 429
    u = db.q1("SELECT * FROM users WHERE email = ?", (email,))
    if u is None or not check_password_hash(u["password_hash"], str(d.get("password") or "")):
        time.sleep(0.4)
        return jsonify({"ok": False, "error": "Wrong email or password", "code": "bad_login"}), 401
    if not u["active"]:
        return jsonify({"ok": False, "error": "This account is disabled", "code": "disabled"}), 403
    start_session(u)
    login_limit_email.reset(email)
    db.audit(u["restaurant_id"], email, "login", ip)
    nxt = d.get("next") or ""
    if not (isinstance(nxt, str) and nxt.startswith("/") and not nxt.startswith("//")):
        nxt = ""
    return ok(redirect=nxt or home_for(u))


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login_page"))


# ================================================================= app pages

@app.route("/admin")
@page(("platform", "manager", "waiter"))
def admin_page():
    return render_template("admin.html", v=ASSET_VERSION, boot=boot_json(admin_boot()))


@app.route("/kitchen")
@page(ROLES)
def kitchen_page():
    if g.rest is None:
        return redirect(url_for("admin_page"))
    return render_template("kitchen.html", v=ASSET_VERSION, boot=boot_json({
        "csrf": csrf_token(), "user": user_public(g.user),
        "restaurant": svc.public_restaurant(g.rest), "rev": svc.current_rev(g.rest["id"]),
    }))


def admin_boot():
    return {
        "csrf": csrf_token(),
        "user": user_public(g.user),
        "restaurant": restaurant_admin(g.rest) if g.rest else None,
        "version": app_paths.APP_VERSION,
        "tags": svc.TAGS, "allergens": svc.ALLERGENS, "languages": svc.LANGUAGES,
        "currencies": CURRENCIES,
    }


# ================================================================= customer side

def table_by_token(token):
    if not token or len(token) > 40:
        return None
    return db.q1("SELECT * FROM tables WHERE token = ?", (token,))


@app.route("/t/<token>")
def menu_table(token):
    t = table_by_token(token)
    if t is None:
        abort(404)
    rest = svc.get_restaurant(t["restaurant_id"])
    return render_menu(rest, t)


@app.route("/r/<slug>")
def menu_browse(slug):
    rest = db.q1("SELECT * FROM restaurants WHERE slug = ?", (slug,))
    if rest is None:
        abort(404)
    return render_menu(rest, None)


def render_menu(rest, table):
    accent = rest["accent"] if svc.HEX_COLOR.match(rest["accent"] or "") else "#e4572e"
    data = {
        "restaurant": svc.public_restaurant(rest),
        "table": {"label": table["label"], "token": table["token"], "active": bool(table["active"])} if table else None,
        "menu": svc.public_menu(rest) if svc.subscription_ok(rest) else [],
    }
    return render_template("menu.html", v=ASSET_VERSION, boot=boot_json(data), accent=accent,
                           title=rest["name"], lang=rest["language"],
                           rtl=rest["language"] == "ar")


def _public_guard():
    if not public_read_limit.hit(client_ip()):
        raise ServiceError("Slow down a little", "rate", 429)


@app.route("/api/p/menu/<token>")
def api_public_menu(token):
    _public_guard()
    t = table_by_token(token)
    if t is None:
        raise ServiceError("Unknown table", "no_table", 404)
    rest = svc.get_restaurant(t["restaurant_id"])
    return ok(restaurant=svc.public_restaurant(rest),
              menu=svc.public_menu(rest) if svc.subscription_ok(rest) else [])


@app.route("/api/p/order/<token>", methods=["POST"])
def api_public_order(token):
    t = table_by_token(token)
    if t is None:
        raise ServiceError("This table code is no longer valid - please rescan the QR code", "no_table", 404)
    if not order_limit_table.hit(token) or not order_limit_ip.hit(client_ip()):
        raise ServiceError("Too many orders in a short time. Please ask a waiter.", "rate", 429)
    o = svc.place_order(t, body(), client_ip())
    return ok(order=svc.public_order(o))


@app.route("/api/p/orders")
def api_public_orders():
    """Batch status for the orders this phone placed (tokens kept in localStorage)."""
    _public_guard()
    toks = [x for x in (request.args.get("tokens") or "").split(",") if 0 < len(x) <= 40][:20]
    out = []
    for tok in toks:
        row = db.q1("SELECT id FROM orders WHERE public_token = ?", (tok,))
        if row:
            out.append(svc.public_order(svc.order_detail(row["id"])))
    return ok(orders=out)


@app.route("/api/p/call/<token>", methods=["POST"])
def api_public_call(token):
    t = table_by_token(token)
    if t is None:
        raise ServiceError("Unknown table", "no_table", 404)
    if not call_limit_table.hit(token + client_ip()):
        raise ServiceError("We've got your request - someone is on the way", "rate", 429)
    d = body()
    _, created = svc.create_call(t, d.get("kind"), d.get("payment") or "")
    return ok(created=created)


@app.route("/u/<path:name>")
def uploads(name):
    resp = send_from_directory(app_paths.UPLOAD_DIR, name, max_age=60 * 60 * 24 * 30)
    resp.headers["Cache-Control"] = "public, max-age=2592000, immutable"
    return resp


@app.route("/favicon.ico")
def favicon():
    return redirect("/static/favicon.svg", code=301)


@app.route("/api/health")
def health():
    return ok(app=app_paths.APP_NAME, version=app_paths.APP_VERSION)


# ================================================================= staff: live board

@app.route("/api/s/board")
@api(ROLES)
def api_board():
    rid = g.rest["id"]
    since = svc.to_int(request.args.get("rev"), -1)
    wait = request.args.get("wait") == "1"
    rev = svc.current_rev(rid)
    if wait and since == rev:
        rev = svc.wait_for_change(rid, since, timeout=20)
        if rev == since:
            return ok(changed=False, rev=rev)
    return ok(changed=True, rev=rev, **svc.board(rid))


@app.route("/api/s/orders/<int:oid>/status", methods=["POST"])
@api(ROLES)
def api_order_status(oid):
    d = body()
    status = d.get("status")
    if g.user["role"] == "kitchen" and status not in ("new", "preparing", "ready"):
        raise ServiceError("The kitchen can only move orders to Preparing or Ready", "forbidden", 403)
    o = svc.set_status(g.rest["id"], oid, status, d.get("reason") or "")
    audit("order_status", "#%s -> %s" % (o["number"], status))
    return ok(order=o)


@app.route("/api/s/orders/<int:oid>/pay", methods=["POST"])
@api(("platform", "manager", "waiter"))
def api_order_pay(oid):
    d = body()
    o = svc.set_paid(g.rest["id"], oid, bool(d.get("paid", True)), d.get("method") or "")
    audit("order_paid" if o["paid"] else "order_unpaid", "#%s %s" % (o["number"], o["payment_method"]))
    return ok(order=o)


@app.route("/api/s/tables/<int:tid>/settle", methods=["POST"])
@api(("platform", "manager", "waiter"))
def api_settle_table(tid):
    """Mark every unpaid, non-cancelled order of a table as paid (one bill for the whole table)."""
    d = body()
    method = d.get("method") if d.get("method") in svc.PAYMENT_METHODS else "cash"
    rid = g.rest["id"]
    ts = db.now()
    n = db.conn().execute(
        "UPDATE orders SET paid = 1, payment_method = ?, paid_at = ?, updated_at = ? "
        "WHERE restaurant_id = ? AND table_id = ? AND paid = 0 AND status != 'cancelled'",
        (method, ts, ts, rid, tid)).rowcount
    db.conn().execute(
        "UPDATE calls SET resolved_at = ?, resolved_by = ? WHERE restaurant_id = ? AND table_id = ? "
        "AND kind = 'bill' AND resolved_at IS NULL", (ts, g.user["email"], rid, tid))
    svc.bump(rid)
    audit("table_settled", "table %s: %d orders, %s" % (tid, n, method))
    return ok(settled=n)


@app.route("/api/s/orders/<int:oid>")
@api(ROLES)
def api_order_get(oid):
    o = svc.order_detail(oid, g.rest["id"])
    if o is None:
        raise ServiceError("Order not found", "not_found", 404)
    o.pop("client_ip", None)
    return ok(order=o)


@app.route("/api/s/calls/<int:cid>/resolve", methods=["POST"])
@api(ROLES)
def api_call_resolve(cid):
    svc.resolve_call(g.rest["id"], cid, g.user["email"])
    return ok()


@app.route("/api/s/items/<int:iid>/availability", methods=["POST"])
@api(("platform", "manager", "waiter", "kitchen"))
def api_item_availability(iid):
    """Kitchen and floor can mark a dish sold out without touching the rest of the menu."""
    avail = 1 if body().get("available") else 0
    n = db.update_fields("items", iid, {"available": avail, "updated_at": db.now()},
                         "AND restaurant_id = ?", (g.rest["id"],))
    if not n:
        raise ServiceError("Item not found", "not_found", 404)
    audit("item_available" if avail else "item_sold_out", str(iid))
    return ok()


@app.route("/api/s/menu-lite")
@api(ROLES)
def api_menu_lite():
    rows = db.q("SELECT i.id, i.name, i.available, c.name AS category FROM items i "
                "JOIN categories c ON c.id = i.category_id WHERE i.restaurant_id = ? AND i.visible = 1 "
                "ORDER BY c.sort, c.id, i.sort, i.id", (g.rest["id"],))
    return ok(items=db.rows_dicts(rows))


# ================================================================= admin: restaurant data

CURRENCIES = [
    {"code": "USD", "symbol": "$", "suffix": False, "decimals": 2, "name": "US Dollar"},
    {"code": "EUR", "symbol": "€", "suffix": True, "decimals": 2, "name": "Euro"},
    {"code": "GBP", "symbol": "£", "suffix": False, "decimals": 2, "name": "British Pound"},
    {"code": "MAD", "symbol": "DH", "suffix": True, "decimals": 2, "name": "Moroccan Dirham"},
    {"code": "AED", "symbol": "AED", "suffix": True, "decimals": 2, "name": "UAE Dirham"},
    {"code": "SAR", "symbol": "SAR", "suffix": True, "decimals": 2, "name": "Saudi Riyal"},
    {"code": "EGP", "symbol": "EGP", "suffix": True, "decimals": 2, "name": "Egyptian Pound"},
    {"code": "DZD", "symbol": "DA", "suffix": True, "decimals": 2, "name": "Algerian Dinar"},
    {"code": "TND", "symbol": "DT", "suffix": True, "decimals": 3, "name": "Tunisian Dinar"},
    {"code": "TRY", "symbol": "₺", "suffix": False, "decimals": 2, "name": "Turkish Lira"},
    {"code": "INR", "symbol": "₹", "suffix": False, "decimals": 2, "name": "Indian Rupee"},
    {"code": "PKR", "symbol": "Rs", "suffix": False, "decimals": 0, "name": "Pakistani Rupee"},
    {"code": "CAD", "symbol": "CA$", "suffix": False, "decimals": 2, "name": "Canadian Dollar"},
    {"code": "AUD", "symbol": "A$", "suffix": False, "decimals": 2, "name": "Australian Dollar"},
    {"code": "CHF", "symbol": "CHF", "suffix": True, "decimals": 2, "name": "Swiss Franc"},
    {"code": "BRL", "symbol": "R$", "suffix": False, "decimals": 2, "name": "Brazilian Real"},
    {"code": "MXN", "symbol": "MX$", "suffix": False, "decimals": 2, "name": "Mexican Peso"},
    {"code": "NGN", "symbol": "₦", "suffix": False, "decimals": 2, "name": "Nigerian Naira"},
    {"code": "XOF", "symbol": "CFA", "suffix": True, "decimals": 0, "name": "CFA Franc"},
    {"code": "JPY", "symbol": "¥", "suffix": False, "decimals": 0, "name": "Japanese Yen"},
]

SETTINGS_TEXT = {"name": 80, "tagline": 140, "phone": 40, "address": 200, "wifi_name": 60,
                 "wifi_password": 60, "closed_message": 200, "currency_symbol": 6}
SETTINGS_BOOL = ("ordering_enabled", "tax_inclusive", "require_name", "auto_accept", "currency_suffix")


def restaurant_admin(rest):
    d = dict(rest)
    d["public"] = svc.public_restaurant(rest)
    d["subscription_ok"] = svc.subscription_ok(rest)
    return d


@app.route("/api/a/bootstrap")
@api(("platform", "manager", "waiter"))
def api_admin_bootstrap():
    return ok(**admin_boot())


@app.route("/api/a/report")
@api(("platform", "manager"))
def api_report():
    days = svc.to_int(request.args.get("days"), 1, 1, 366)
    return ok(report=svc.report(g.rest, days))


@app.route("/api/a/settings", methods=["GET", "PUT"])
@api(("platform", "manager"))
def api_settings():
    rest = g.rest
    if request.method == "GET":
        pub, source = public_base()
        return ok(restaurant=restaurant_admin(rest), public_url=pub, public_url_source=source,
                  lan_url="http://%s:%s" % (lan_ip(), request.host.partition(":")[2] or "80"))
    d = body()
    fields = {}
    for k, n in SETTINGS_TEXT.items():
        if k in d:
            fields[k] = svc.clean_text(d[k], n)
    if "name" in fields and not fields["name"]:
        raise ServiceError("The restaurant needs a name", "field", field="name")
    for k in SETTINGS_BOOL:
        if k in d:
            fields[k] = 1 if d[k] else 0
    if "accent" in d:
        if not svc.HEX_COLOR.match(str(d["accent"])):
            raise ServiceError("Pick a valid color", "field", field="accent")
        fields["accent"] = d["accent"]
    if "currency" in d:
        cur = svc.clean_text(d["currency"], 3).upper()
        if len(cur) != 3:
            raise ServiceError("Invalid currency", "field", field="currency")
        fields["currency"] = cur
    if "decimals" in d:
        new_dec = svc.to_int(d["decimals"], 2, 0, 3)
        if new_dec != rest["decimals"]:
            has_items = db.q1("SELECT 1 FROM items WHERE restaurant_id = ? AND price > 0 LIMIT 1", (rest["id"],))
            if has_items:
                raise ServiceError("Decimals can't change once prices exist (prices would be rescaled).",
                                   "field", field="decimals")
        fields["decimals"] = new_dec
    for k in ("tax_rate", "service_rate"):
        if k in d:
            # UI sends percent (e.g. 10 or "7.5") -> basis points
            try:
                pct = float(str(d[k]).replace(",", ".") or 0)
            except ValueError:
                raise ServiceError("Invalid percentage", "field", field=k)
            if not 0 <= pct <= 100:
                raise ServiceError("Percentage must be between 0 and 100", "field", field=k)
            fields[k] = int(round(pct * 100))
    if "language" in d and d["language"] in svc.LANGUAGES:
        fields["language"] = d["language"]
    if "timezone" in d:
        tz = svc.clean_text(d["timezone"], 60)
        if not svc.valid_timezone(tz):
            raise ServiceError("Unknown time zone (use a name like Europe/Paris)", "field", field="timezone")
        fields["timezone"] = tz
    for k in ("logo", "cover"):
        if k in d:
            new = svc.clean_text(d[k], 80)
            if new and not os.path.exists(os.path.join(app_paths.UPLOAD_DIR, new)):
                raise ServiceError("Image not found - upload it again", "field", field=k)
            if rest[k] and rest[k] != new:
                media.delete_image(rest[k])
            fields[k] = new
    if "public_url" in d and g.user["role"] == "platform":
        url = svc.clean_text(d["public_url"], 200).rstrip("/")
        if url and not (url.startswith("http://") or url.startswith("https://")):
            raise ServiceError("Public URL must start with http:// or https://", "field", field="public_url")
        db.run("INSERT INTO meta(key, value) VALUES('public_url', ?) "
               "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (url,))
    db.update_fields("restaurants", rest["id"], fields)
    svc.bump(rest["id"])
    audit("settings", ",".join(fields))
    g.rest = svc.get_restaurant(rest["id"])
    pub, source = public_base()
    return ok(restaurant=restaurant_admin(g.rest), public_url=pub, public_url_source=source)


@app.route("/api/a/upload", methods=["POST"])
@api(("platform", "manager"))
def api_upload():
    f = request.files.get("file")
    if f is None:
        raise ServiceError("No file received", "no_file")
    kind = request.args.get("kind", "item")
    name = media.save_image(f, kind)
    return ok(name=name, url="/u/" + name)


# ---------------------------------------------------------------- categories

def _cat_fields(d, partial=False):
    f = {}
    if "name" in d or not partial:
        f["name"] = svc.clean_text(d.get("name"), 60)
        if not f["name"]:
            raise ServiceError("Category name is required", "field", field="name")
    if "description" in d:
        f["description"] = svc.clean_text(d.get("description"), 200)
    if "icon" in d:
        f["icon"] = svc.clean_text(d.get("icon"), 8)
    if "visible" in d:
        f["visible"] = 1 if d.get("visible") else 0
    for k in ("available_from", "available_to"):
        if k in d:
            v = svc.clean_text(d.get(k), 5)
            if v and not svc.HHMM.match(v):
                raise ServiceError("Use HH:MM for serving hours", "field", field=k)
            f[k] = v
    if bool(f.get("available_from")) != bool(f.get("available_to")) and ("available_from" in f or "available_to" in f):
        raise ServiceError("Set both a start and an end time (or neither)", "field", field="available_to")
    return f


@app.route("/api/a/menu")
@api(("platform", "manager"))
def api_menu_full():
    cats, items = svc.load_menu(g.rest["id"], include_hidden=True)
    counts = {r["item_id"]: r["n"] for r in db.q(
        "SELECT oi.item_id, SUM(oi.qty) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id "
        "WHERE o.restaurant_id = ? AND o.created_at >= ? AND o.status != 'cancelled' GROUP BY oi.item_id",
        (g.rest["id"], db.now() - 30 * 86400))}
    for it in items:
        it["sold_30d"] = counts.get(it["id"], 0)
    return ok(categories=cats, items=items)


@app.route("/api/a/categories", methods=["POST"])
@api(("platform", "manager"))
def api_cat_create():
    f = _cat_fields(body())
    rid = g.rest["id"]
    sort = (db.q1("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE restaurant_id = ?", (rid,))["s"])
    cid = db.run("INSERT INTO categories(restaurant_id, name, sort) VALUES(?,?,?)", (rid, f.pop("name"), sort))
    db.update_fields("categories", cid, f)
    audit("category_create", cid)
    return ok(category=db.row_dict(db.q1("SELECT * FROM categories WHERE id = ?", (cid,))))


@app.route("/api/a/categories/<int:cid>", methods=["PUT", "DELETE"])
@api(("platform", "manager"))
def api_cat_edit(cid):
    rid = g.rest["id"]
    cat = db.q1("SELECT * FROM categories WHERE id = ? AND restaurant_id = ?", (cid, rid))
    if cat is None:
        raise ServiceError("Category not found", "not_found", 404)
    if request.method == "DELETE":
        n = db.q1("SELECT COUNT(*) AS n FROM items WHERE category_id = ?", (cid,))["n"]
        if n and not request.args.get("force"):
            raise ServiceError("This category still has %d item(s)" % n, "not_empty", 409, count=n)
        for r in db.q("SELECT image FROM items WHERE category_id = ?", (cid,)):
            media.delete_image(r["image"])
        db.run("DELETE FROM categories WHERE id = ?", (cid,))
        audit("category_delete", cat["name"])
        return ok()
    d = body()
    f = _cat_fields(d, partial=True)
    merged_from = f.get("available_from", cat["available_from"])
    merged_to = f.get("available_to", cat["available_to"])
    if bool(merged_from) != bool(merged_to):
        raise ServiceError("Set both a start and an end time (or neither)", "field", field="available_to")
    db.update_fields("categories", cid, f)
    audit("category_update", cid)
    return ok(category=db.row_dict(db.q1("SELECT * FROM categories WHERE id = ?", (cid,))))


@app.route("/api/a/categories/reorder", methods=["POST"])
@api(("platform", "manager"))
def api_cat_reorder():
    ids = [svc.to_int(x) for x in (body().get("ids") or [])]
    rid = g.rest["id"]
    with db.tx() as c:
        for i, cid in enumerate(ids):
            c.execute("UPDATE categories SET sort = ? WHERE id = ? AND restaurant_id = ?", (i, cid, rid))
    return ok()


# ---------------------------------------------------------------- items

def _item_fields(d, rest, partial=False):
    f = {}
    dec = rest["decimals"]
    if "name" in d or not partial:
        f["name"] = svc.clean_text(d.get("name"), 80)
        if not f["name"]:
            raise ServiceError("Item name is required", "field", field="name")
    if "category_id" in d or not partial:
        cid = svc.to_int(d.get("category_id"))
        if not db.q1("SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?", (cid, rest["id"])):
            raise ServiceError("Choose a category", "field", field="category_id")
        f["category_id"] = cid
    if "price" in d or not partial:
        try:
            f["price"] = svc.money_to_minor(d.get("price") or 0, dec)
        except ServiceError:
            raise ServiceError("Enter a valid price", "field", field="price")
    if "compare_price" in d:
        try:
            f["compare_price"] = svc.money_to_minor(d.get("compare_price") or 0, dec)
        except ServiceError:
            raise ServiceError("Enter a valid price", "field", field="compare_price")
    if "description" in d:
        f["description"] = svc.clean_text(d.get("description"), 400)
    if "emoji" in d:
        f["emoji"] = svc.clean_text(d.get("emoji"), 8)
    if "image" in d:
        img = svc.clean_text(d.get("image"), 80)
        if img and not os.path.exists(os.path.join(app_paths.UPLOAD_DIR, img)):
            raise ServiceError("Image not found - upload it again", "field", field="image")
        f["image"] = img
    if "tags" in d:
        f["tags"] = json.dumps(svc.clean_list(d.get("tags"), svc.TAGS))
    if "allergens" in d:
        f["allergens"] = json.dumps(svc.clean_list(d.get("allergens"), svc.ALLERGENS))
    if "calories" in d:
        f["calories"] = svc.to_int(d.get("calories"), 0, 0, 20000)
    if "prep_minutes" in d:
        f["prep_minutes"] = svc.to_int(d.get("prep_minutes"), 0, 0, 240)
    if "options" in d:
        f["options"] = json.dumps(svc.normalize_options(d.get("options"), dec), ensure_ascii=False)
    for k in ("available", "visible"):
        if k in d:
            f[k] = 1 if d.get(k) else 0
    return f


def _item_out(iid):
    return db.row_dict(db.q1("SELECT * FROM items WHERE id = ?", (iid,)), ("tags", "allergens", "options"))


@app.route("/api/a/items", methods=["POST"])
@api(("platform", "manager"))
def api_item_create():
    rest = g.rest
    f = _item_fields(body(), rest)
    ts = db.now()
    sort = db.q1("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM items WHERE category_id = ?", (f["category_id"],))["s"]
    iid = db.run("INSERT INTO items(restaurant_id, category_id, name, price, sort, created_at, updated_at) "
                 "VALUES(?,?,?,?,?,?,?)", (rest["id"], f.pop("category_id"), f.pop("name"), f.pop("price"), sort, ts, ts))
    db.update_fields("items", iid, f)
    audit("item_create", iid)
    return ok(item=_item_out(iid))


@app.route("/api/a/items/<int:iid>", methods=["PUT", "DELETE"])
@api(("platform", "manager"))
def api_item_edit(iid):
    rest = g.rest
    it = db.q1("SELECT * FROM items WHERE id = ? AND restaurant_id = ?", (iid, rest["id"]))
    if it is None:
        raise ServiceError("Item not found", "not_found", 404)
    if request.method == "DELETE":
        db.run("DELETE FROM items WHERE id = ?", (iid,))
        if it["image"] and not db.q1("SELECT 1 FROM items WHERE image = ?", (it["image"],)):
            media.delete_image(it["image"])
        audit("item_delete", it["name"])
        return ok()
    f = _item_fields(body(), rest, partial=True)
    if "category_id" in f and f["category_id"] != it["category_id"]:
        f["sort"] = db.q1("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM items WHERE category_id = ?",
                          (f["category_id"],))["s"]
    f["updated_at"] = db.now()
    old_img = it["image"]
    db.update_fields("items", iid, f)
    if "image" in f and old_img and old_img != f["image"] and not db.q1("SELECT 1 FROM items WHERE image = ?", (old_img,)):
        media.delete_image(old_img)
    audit("item_update", iid)
    return ok(item=_item_out(iid))


@app.route("/api/a/items/<int:iid>/duplicate", methods=["POST"])
@api(("platform", "manager"))
def api_item_duplicate(iid):
    it = db.q1("SELECT * FROM items WHERE id = ? AND restaurant_id = ?", (iid, g.rest["id"]))
    if it is None:
        raise ServiceError("Item not found", "not_found", 404)
    ts = db.now()
    cols = [k for k in it.keys() if k not in ("id", "created_at", "updated_at", "name", "sort")]
    new_id = db.run(
        "INSERT INTO items(%s, name, sort, created_at, updated_at) VALUES(%s,?,?,?,?)"
        % (", ".join(cols), ",".join("?" * len(cols))),
        [it[k] for k in cols] + [(it["name"] + " (copy)")[:80], it["sort"] + 1, ts, ts])
    return ok(item=_item_out(new_id))


@app.route("/api/a/items/reorder", methods=["POST"])
@api(("platform", "manager"))
def api_item_reorder():
    d = body()
    cid = svc.to_int(d.get("category_id"))
    rid = g.rest["id"]
    if not db.q1("SELECT 1 FROM categories WHERE id = ? AND restaurant_id = ?", (cid, rid)):
        raise ServiceError("Category not found", "not_found", 404)
    with db.tx() as c:
        for i, iid in enumerate(svc.to_int(x) for x in (d.get("ids") or [])):
            c.execute("UPDATE items SET sort = ?, category_id = ? WHERE id = ? AND restaurant_id = ?",
                      (i, cid, iid, rid))
    return ok()


@app.route("/api/a/items/restock-all", methods=["POST"])
@api(("platform", "manager"))
def api_items_restock():
    n = db.conn().execute("UPDATE items SET available = 1, updated_at = ? WHERE restaurant_id = ? AND available = 0",
                          (db.now(), g.rest["id"])).rowcount
    audit("restock_all", n)
    return ok(count=n)


# ---------------------------------------------------------------- tables & QR

def _table_out(row):
    d = dict(row)
    d["url"] = table_url(row["token"])
    return d


@app.route("/api/a/tables", methods=["GET", "POST"])
@api(("platform", "manager"))
def api_tables():
    rid = g.rest["id"]
    if request.method == "GET":
        rows = db.q("SELECT * FROM tables WHERE restaurant_id = ? ORDER BY sort, id", (rid,))
        stats = {r["table_id"]: dict(r) for r in db.q(
            "SELECT table_id, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, MAX(created_at) AS last "
            "FROM orders WHERE restaurant_id = ? AND status != 'cancelled' AND created_at >= ? GROUP BY table_id",
            (rid, db.now() - 30 * 86400))}
        out = []
        for r in rows:
            t = _table_out(r)
            t["stats"] = stats.get(r["id"], {"orders": 0, "revenue": 0, "last": None})
            out.append(t)
        pub, source = public_base()
        return ok(tables=out, public_url=pub, public_url_source=source)
    d = body()
    count_existing = db.q1("SELECT COUNT(*) AS n FROM tables WHERE restaurant_id = ?", (rid,))["n"]
    zone = svc.clean_text(d.get("zone"), 40)
    seats = svc.to_int(d.get("seats"), 0, 0, 99)
    labels = []
    if d.get("bulk"):
        prefix = svc.clean_text(d.get("prefix"), 30) or "Table"
        a = svc.to_int(d.get("from"), 1, 0, 9999)
        b = svc.to_int(d.get("to"), a, 0, 9999)
        if b < a:
            a, b = b, a
        if b - a >= 200:
            raise ServiceError("Create at most 200 tables at once", "field", field="to")
        labels = ["%s %d" % (prefix, i) for i in range(a, b + 1)]
    else:
        label = svc.clean_text(d.get("label"), 40)
        if not label:
            raise ServiceError("Give the table a name", "field", field="label")
        labels = [label]
    if count_existing + len(labels) > 1000:
        raise ServiceError("A restaurant can have at most 1000 tables", "limit")
    ts = db.now()
    with db.tx() as c:
        for i, label in enumerate(labels):
            c.execute("INSERT INTO tables(restaurant_id, label, zone, seats, token, sort, created_at) "
                      "VALUES(?,?,?,?,?,?,?)", (rid, label, zone, seats, svc.new_token(9), count_existing + i, ts))
    audit("tables_create", len(labels))
    return ok(created=len(labels))


@app.route("/api/a/tables/<int:tid>", methods=["PUT", "DELETE"])
@api(("platform", "manager"))
def api_table_edit(tid):
    rid = g.rest["id"]
    t = db.q1("SELECT * FROM tables WHERE id = ? AND restaurant_id = ?", (tid, rid))
    if t is None:
        raise ServiceError("Table not found", "not_found", 404)
    if request.method == "DELETE":
        db.run("DELETE FROM tables WHERE id = ?", (tid,))
        audit("table_delete", t["label"])
        return ok()
    d = body()
    f = {}
    if "label" in d:
        f["label"] = svc.clean_text(d["label"], 40)
        if not f["label"]:
            raise ServiceError("Give the table a name", "field", field="label")
    if "zone" in d:
        f["zone"] = svc.clean_text(d["zone"], 40)
    if "seats" in d:
        f["seats"] = svc.to_int(d["seats"], 0, 0, 99)
    if "active" in d:
        f["active"] = 1 if d["active"] else 0
    if d.get("regenerate"):
        f["token"] = svc.new_token(9)
        audit("table_new_qr", t["label"])
    db.update_fields("tables", tid, f)
    return ok(table=_table_out(db.q1("SELECT * FROM tables WHERE id = ?", (tid,))))


@app.route("/qr/<int:tid>.<fmt>")
@page(("platform", "manager"))
def qr_image(tid, fmt):
    t = db.q1("SELECT * FROM tables WHERE id = ? AND restaurant_id = ?", (tid, g.rest["id"]))
    if t is None or fmt not in ("svg", "png"):
        abort(404)
    url = table_url(t["token"])
    fname = "qr-%s.%s" % (svc.slugify(t["label"]), fmt)
    if fmt == "svg":
        resp = Response(media.qr_svg(url), mimetype="image/svg+xml")
    else:
        resp = Response(media.qr_png(url), mimetype="image/png")
    if request.args.get("download"):
        resp.headers["Content-Disposition"] = 'attachment; filename="%s"' % fname
    return resp


@app.route("/print/qr")
@page(("platform", "manager"))
def print_qr():
    rid = g.rest["id"]
    ids = [svc.to_int(x) for x in (request.args.get("ids") or "").split(",") if x.strip()]
    if ids:
        marks = ",".join("?" * len(ids))
        rows = db.q("SELECT * FROM tables WHERE restaurant_id = ? AND id IN (%s) ORDER BY sort, id" % marks, [rid, *ids])
    else:
        rows = db.q("SELECT * FROM tables WHERE restaurant_id = ? AND active = 1 ORDER BY sort, id", (rid,))
    style = request.args.get("style", "card")
    per_page = {"card": 6, "tent": 2, "sticker": 12}.get(style, 6)
    cards = [{"label": r["label"], "zone": r["zone"], "url": table_url(r["token"]),
              "svg": media.qr_svg(table_url(r["token"]), dark="#111111", light=None, scale=8, border=0)}
             for r in rows]
    rest = g.rest
    return render_template("print_qr.html", cards=cards, rest=rest, style=style, per_page=per_page,
                           accent=rest["accent"] if svc.HEX_COLOR.match(rest["accent"] or "") else "#e4572e",
                           heading=svc.clean_text(request.args.get("heading"), 60) or "",
                           v=ASSET_VERSION, lang=rest["language"])


@app.route("/print/order/<int:oid>")
@page(ROLES)
def print_order(oid):
    o = svc.order_detail(oid, g.rest["id"])
    if o is None:
        abort(404)
    kind = "bill" if request.args.get("kind") == "bill" else "ticket"
    return render_template("print_order.html", o=o, rest=g.rest, kind=kind, v=ASSET_VERSION,
                           created=datetime.fromtimestamp(o["created_at"], svc.tzinfo_for(g.rest)))


@app.route("/print/table/<int:tid>")
@page(("platform", "manager", "waiter"))
def print_table_bill(tid):
    """One combined bill for all unpaid orders of a table."""
    rid = g.rest["id"]
    t = db.q1("SELECT * FROM tables WHERE id = ? AND restaurant_id = ?", (tid, rid))
    if t is None:
        abort(404)
    rows = db.q("SELECT id FROM orders WHERE restaurant_id = ? AND table_id = ? AND paid = 0 "
                "AND status != 'cancelled' ORDER BY created_at", (rid, tid))
    orders = [svc.order_detail(r["id"]) for r in rows]
    totals = {k: sum(o[k] for o in orders) for k in ("subtotal", "tax", "service", "total")}
    return render_template("print_order.html", o=None, orders=orders, totals=totals, table=t, rest=g.rest,
                           kind="table", v=ASSET_VERSION,
                           created=svc.local_now(g.rest))


# ---------------------------------------------------------------- order history

def _order_filters():
    rid = g.rest["id"]
    where, args = ["restaurant_id = ?"], [rid]
    st = request.args.get("status") or ""
    if st in svc.STATUSES:
        where.append("status = ?")
        args.append(st)
    elif st == "active":
        where.append("status IN ('new','preparing','ready')")
    elif st == "unpaid":
        where.append("paid = 0 AND status != 'cancelled'")
    days = svc.to_int(request.args.get("days"), 0, 0, 3660)
    if days:
        where.append("created_at >= ?")
        args.append(svc.local_day_start(g.rest, days - 1))
    q = svc.clean_text(request.args.get("q"), 60)
    if q:
        if q.lstrip("#").isdigit():
            where.append("number = ?")
            args.append(int(q.lstrip("#")))
        else:
            where.append("(table_label LIKE ? OR customer_name LIKE ? OR note LIKE ?)")
            args += ["%" + q + "%"] * 3
    return " AND ".join(where), args


@app.route("/api/a/orders")
@api(("platform", "manager", "waiter"))
def api_orders():
    where, args = _order_filters()
    page_n = svc.to_int(request.args.get("page"), 1, 1, 100000)
    per = 30
    total = db.q1("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS rev "
                  "FROM orders WHERE " + where, args)
    rows = db.q("SELECT * FROM orders WHERE %s ORDER BY created_at DESC LIMIT ? OFFSET ?" % where,
                args + [per, (page_n - 1) * per])
    orders = db.rows_dicts(rows)
    for o in orders:
        o.pop("client_ip", None)
    return ok(orders=orders, total=total["n"], revenue=total["rev"], page=page_n, pages=max(1, -(-total["n"] // per)))


@app.route("/api/a/orders.csv")
@api(("platform", "manager"))
def api_orders_csv():
    where, args = _order_filters()
    rows = db.q("SELECT * FROM orders WHERE %s ORDER BY created_at DESC LIMIT 100000" % where, args)
    rest = g.rest
    tz = svc.tzinfo_for(rest)
    div = 10 ** rest["decimals"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Order #", "Date", "Time", "Table", "Customer", "Status", "Items", "Subtotal", "Service",
                "Tax", "Total", "Paid", "Payment method", "Note"])
    for o in rows:
        dt = datetime.fromtimestamp(o["created_at"], tz)
        w.writerow([o["number"], dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M"), o["table_label"],
                    o["customer_name"], o["status"], o["item_count"],
                    "%.*f" % (rest["decimals"], o["subtotal"] / div), "%.*f" % (rest["decimals"], o["service"] / div),
                    "%.*f" % (rest["decimals"], o["tax"] / div), "%.*f" % (rest["decimals"], o["total"] / div),
                    "yes" if o["paid"] else "no", o["payment_method"], o["note"]])
    data = "\ufeff" + buf.getvalue()  # BOM so Excel opens UTF-8 correctly
    return Response(data, mimetype="text/csv", headers={
        "Content-Disposition": 'attachment; filename="orders-%s.csv"' % time.strftime("%Y%m%d")})


# ---------------------------------------------------------------- staff accounts

@app.route("/api/a/staff", methods=["GET", "POST"])
@api(("platform", "manager"))
def api_staff():
    rid = g.rest["id"]
    if request.method == "GET":
        rows = db.q("SELECT id, email, name, role, active, last_login, created_at FROM users "
                    "WHERE restaurant_id = ? ORDER BY role, name", (rid,))
        return ok(staff=db.rows_dicts(rows))
    d = body()
    email = svc.clean_text(d.get("email"), 120).lower()
    role = d.get("role")
    pw = str(d.get("password") or "")
    if "@" not in email:
        raise ServiceError("Enter a valid email", "field", field="email")
    if role not in STAFF_ROLES:
        raise ServiceError("Choose a role", "field", field="role")
    if len(pw) < 8:
        raise ServiceError("Password must be at least 8 characters", "field", field="password")
    if db.q1("SELECT 1 FROM users WHERE email = ?", (email,)):
        raise ServiceError("That email already has an account", "field", field="email")
    uid = db.run("INSERT INTO users(restaurant_id, email, name, role, password_hash, created_at) VALUES(?,?,?,?,?,?)",
                 (rid, email, svc.clean_text(d.get("name"), 80), role, generate_password_hash(pw), db.now()))
    audit("staff_create", "%s (%s)" % (email, role))
    return ok(id=uid)


@app.route("/api/a/staff/<int:uid>", methods=["PUT", "DELETE"])
@api(("platform", "manager"))
def api_staff_edit(uid):
    rid = g.rest["id"]
    u = db.q1("SELECT * FROM users WHERE id = ? AND restaurant_id = ?", (uid, rid))
    if u is None:
        raise ServiceError("Account not found", "not_found", 404)
    if request.method == "DELETE":
        if uid == g.user["id"]:
            raise ServiceError("You can't delete your own account", "self")
        _guard_last_manager(rid, uid)
        db.run("DELETE FROM users WHERE id = ?", (uid,))
        audit("staff_delete", u["email"])
        return ok()
    d = body()
    f = {}
    if "name" in d:
        f["name"] = svc.clean_text(d["name"], 80)
    if "role" in d:
        if d["role"] not in STAFF_ROLES:
            raise ServiceError("Choose a role", "field", field="role")
        if d["role"] != "manager" and u["role"] == "manager":
            _guard_last_manager(rid, uid)
        f["role"] = d["role"]
    if "active" in d:
        if not d["active"]:
            if uid == g.user["id"]:
                raise ServiceError("You can't disable your own account", "self")
            if u["role"] == "manager":
                _guard_last_manager(rid, uid)
        f["active"] = 1 if d["active"] else 0
    if d.get("password"):
        if len(str(d["password"])) < 8:
            raise ServiceError("Password must be at least 8 characters", "field", field="password")
        f["password_hash"] = generate_password_hash(str(d["password"]))
    db.update_fields("users", uid, f)
    audit("staff_update", u["email"])
    return ok()


def _guard_last_manager(rid, uid):
    n = db.q1("SELECT COUNT(*) AS n FROM users WHERE restaurant_id = ? AND role = 'manager' AND active = 1 AND id != ?",
              (rid, uid))["n"]
    if n == 0 and g.user["role"] != "platform":
        raise ServiceError("A restaurant needs at least one active manager", "last_manager")


@app.route("/api/a/me/password", methods=["POST"])
@api(ROLES, need_rest=False)
def api_my_password():
    d = body()
    if not check_password_hash(g.user["password_hash"], str(d.get("current") or "")):
        raise ServiceError("Your current password is wrong", "field", field="current")
    new = str(d.get("new") or "")
    if len(new) < 8:
        raise ServiceError("Password must be at least 8 characters", "field", field="new")
    h = generate_password_hash(new)
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", (h, g.user["id"]))
    session["pwv"] = h[-12:]
    audit("password_change")
    return ok()


@app.route("/api/a/activity")
@api(("platform", "manager"))
def api_activity():
    rows = db.q("SELECT user_email, action, detail, created_at FROM audit WHERE restaurant_id = ? "
                "ORDER BY id DESC LIMIT 200", (g.rest["id"],))
    return ok(activity=db.rows_dicts(rows))


# ================================================================= platform (software owner)

@app.route("/api/platform/restaurants", methods=["GET", "POST"])
@api(("platform",), need_rest=False)
def api_platform_restaurants():
    if request.method == "GET":
        since = db.now() - 30 * 86400
        rows = db.q(
            "SELECT r.*, (SELECT COUNT(*) FROM tables t WHERE t.restaurant_id = r.id) AS tables_count, "
            "(SELECT COUNT(*) FROM items i WHERE i.restaurant_id = r.id) AS items_count, "
            "(SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.created_at >= ?) AS orders_30d, "
            "(SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.restaurant_id = r.id AND o.created_at >= ? "
            " AND o.status != 'cancelled') AS revenue_30d, "
            "(SELECT MAX(created_at) FROM orders o WHERE o.restaurant_id = r.id) AS last_order, "
            "(SELECT email FROM users u WHERE u.restaurant_id = r.id AND u.role = 'manager' ORDER BY id LIMIT 1) AS manager_email "
            "FROM restaurants r ORDER BY r.created_at DESC", (since, since))
        out = []
        for r in rows:
            d = dict(r)
            d["subscription_ok"] = svc.subscription_ok(r)
            out.append(d)
        return ok(restaurants=out, current=g.rest["id"] if g.rest else None)
    d = body()
    name = svc.clean_text(d.get("name"), 80)
    if not name:
        raise ServiceError("Restaurant name is required", "field", field="name")
    email = svc.clean_text(d.get("manager_email"), 120).lower()
    pw = str(d.get("manager_password") or "")
    if email:
        if "@" not in email:
            raise ServiceError("Enter a valid manager email", "field", field="manager_email")
        if db.q1("SELECT 1 FROM users WHERE email = ?", (email,)):
            raise ServiceError("That email already has an account", "field", field="manager_email")
        if len(pw) < 8:
            raise ServiceError("Manager password must be at least 8 characters", "field", field="manager_password")
    cur = next((c for c in CURRENCIES if c["code"] == d.get("currency")), CURRENCIES[0])
    rid = svc.create_restaurant(
        name, currency=cur["code"], currency_symbol=cur["symbol"], currency_suffix=1 if cur["suffix"] else 0,
        decimals=cur["decimals"], language=d.get("language") if d.get("language") in svc.LANGUAGES else "en",
        plan=svc.clean_text(d.get("plan"), 30) or "standard",
        paid_until=_parse_date(d.get("paid_until")))
    if email:
        db.run("INSERT INTO users(restaurant_id, email, name, role, password_hash, created_at) VALUES(?,?,?,?,?,?)",
               (rid, email, svc.clean_text(d.get("manager_name"), 80), "manager", generate_password_hash(pw), db.now()))
    if d.get("demo"):
        import seed
        seed.demo_menu(rid)
    db.audit(rid, g.user["email"], "restaurant_create", name)
    return ok(id=rid)


def _parse_date(value):
    """'2026-12-31' -> end of that day (UTC) as unix ts. '' -> None (no expiry)."""
    if not value:
        return None
    try:
        d = datetime.strptime(str(value)[:10], "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
    except ValueError:
        raise ServiceError("Use a date like 2026-12-31", "field", field="paid_until")
    return int(d.timestamp())


@app.route("/api/platform/restaurants/<int:rid>", methods=["PUT", "DELETE"])
@api(("platform",), need_rest=False)
def api_platform_restaurant(rid):
    r = svc.get_restaurant(rid)
    if r is None:
        raise ServiceError("Restaurant not found", "not_found", 404)
    if request.method == "DELETE":
        if svc.clean_text(body().get("confirm"), 80) != r["name"]:
            raise ServiceError("Type the restaurant name to confirm", "confirm")
        imgs = [x["image"] for x in db.q("SELECT image FROM items WHERE restaurant_id = ?", (rid,))] + [r["logo"], r["cover"]]
        db.run("DELETE FROM restaurants WHERE id = ?", (rid,))
        for i in imgs:
            media.delete_image(i)
        if session.get("rid") == rid:
            session.pop("rid", None)
        db.audit(None, g.user["email"], "restaurant_delete", r["name"])
        return ok()
    d = body()
    f = {}
    if "status" in d:
        if d["status"] not in ("active", "suspended"):
            raise ServiceError("Invalid status", "field", field="status")
        f["status"] = d["status"]
    if "plan" in d:
        f["plan"] = svc.clean_text(d["plan"], 30)
    if "paid_until" in d:
        f["paid_until"] = _parse_date(d["paid_until"])
    if "extend_days" in d:
        days = svc.to_int(d["extend_days"], 0, 1, 3660)
        base = max(r["paid_until"] or 0, db.now())
        f["paid_until"] = base + days * 86400
    db.update_fields("restaurants", rid, f)
    svc.bump(rid)
    db.audit(rid, g.user["email"], "subscription_update", json.dumps(f))
    return ok()


@app.route("/api/platform/switch", methods=["POST"])
@api(("platform",), need_rest=False)
def api_platform_switch():
    rid = svc.to_int(body().get("id"))
    if svc.get_restaurant(rid) is None:
        raise ServiceError("Restaurant not found", "not_found", 404)
    session["rid"] = rid
    return ok()


@app.route("/api/platform/backup", methods=["POST"])
@api(("platform",), need_rest=False)
def api_platform_backup():
    path = db.backup()
    return ok(file=os.path.basename(path))


@app.route("/api/platform/backup/latest")
@api(("platform",), need_rest=False)
def api_platform_backup_download():
    path = db.backup()
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


# ================================================================= background + startup

def _backup_loop():
    while True:
        time.sleep(6 * 3600)
        try:
            files = [f for f in os.listdir(app_paths.BACKUP_DIR) if f.endswith(".db")]
            newest = max((os.path.getmtime(os.path.join(app_paths.BACKUP_DIR, f)) for f in files), default=0)
            if time.time() - newest > 20 * 3600:
                db.backup()
        except Exception:
            log.exception("automatic backup failed")


def _already_running(port):
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=1.5) as r:
            return json.loads(r.read().decode()).get("app") == app_paths.APP_NAME
    except Exception:
        return False


def _port_free(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stdout) if sys.stdout else logging.NullHandler(),
                  logging.FileHandler(os.path.join(app_paths.DATA_DIR, "tabletap.log"), encoding="utf-8")])
    host = os.environ.get("TABLETAP_HOST", "0.0.0.0")
    port = int(os.environ.get("TABLETAP_PORT", "5080"))
    installed = os.path.exists(os.path.join(app_paths.BASE_DIR, ".installed"))

    if not _port_free(host, port):
        if _already_running(port):
            print("TableTap is already running - opening it.")
            webbrowser.open("http://127.0.0.1:%d/" % port)
            return
        print("Port %d is busy. Set TABLETAP_PORT to another number." % port)
        sys.exit(1)

    db.init()
    try:
        db.backup()
    except Exception:
        log.exception("startup backup failed")
    threading.Thread(target=_backup_loop, daemon=True).start()

    local = "http://127.0.0.1:%d/" % port
    print("")
    print("  TableTap %s" % app_paths.APP_VERSION)
    print("  Admin (this computer):   %s" % local)
    print("  Phones on the same Wi-Fi: http://%s:%d/" % (lan_ip(), port))
    print("  Data folder:             %s" % app_paths.DATA_DIR)
    print("")
    if installed or os.environ.get("TABLETAP_OPEN_BROWSER") == "1":
        threading.Timer(1.2, lambda: webbrowser.open(local)).start()
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=int(os.environ.get("TABLETAP_THREADS", "48")),
              channel_timeout=60, ident="TableTap")
    except ImportError:
        app.run(host=host, port=port, threaded=True)


db.init()

if __name__ == "__main__":
    main()
