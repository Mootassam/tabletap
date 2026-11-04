"""TableTap domain logic: menus, pricing, orders, live-board revisions and reports.

Rule #1: the server never trusts a price, a name or an option coming from the phone.
Everything a customer sends is re-validated against the database and re-priced here.
"""
import json
import re
import secrets
import threading
import time
import unicodedata
from datetime import datetime, timedelta

import db

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

STATUSES = ("new", "preparing", "ready", "served", "cancelled")
ACTIVE_STATUSES = ("new", "preparing", "ready")
TAGS = ("popular", "new", "chef", "spicy", "veg", "vegan", "gf", "halal")
ALLERGENS = ("gluten", "dairy", "eggs", "nuts", "peanuts", "soy", "fish", "shellfish", "sesame", "celery", "mustard")
LANGUAGES = ("en", "fr", "es", "ar")
PAYMENT_METHODS = ("cash", "card", "other")

MAX_LINES = 60
MAX_QTY = 50
MAX_TOTAL_QTY = 200


class ServiceError(Exception):
    """A user-facing error. `code` lets the phone UI translate it; `message` is English fallback."""

    def __init__(self, message, code="invalid", status=400, **extra):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.extra = extra

    def to_json(self):
        d = {"ok": False, "error": self.message, "code": self.code}
        d.update(self.extra)
        return d


# ---------------------------------------------------------------- small utils

def new_token(nbytes=9):
    return secrets.token_urlsafe(nbytes)


def short_id():
    return secrets.token_hex(3)


def clean_text(value, max_len, default=""):
    if value is None:
        return default
    s = str(value).replace("\x00", "").strip()
    s = re.sub(r"[\r\t]+", " ", s)
    return s[:max_len]


def to_int(value, default=0, lo=None, hi=None):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    if lo is not None and n < lo:
        n = lo
    if hi is not None and n > hi:
        n = hi
    return n


def money_to_minor(value, decimals=2):
    """'12.5' / 12.5 / '12,50' -> 1250 (for 2 decimals). Rejects negatives and junk."""
    if value is None or value == "":
        return 0
    s = str(value).strip().replace(" ", "").replace(",", ".")
    if not re.fullmatch(r"\d{1,9}(\.\d{0,4})?", s):
        raise ServiceError("Invalid price: %s" % value, "bad_price")
    whole, _, frac = s.partition(".")
    frac = (frac + "0000")[:4]
    minor4 = int(whole) * 10000 + int(frac)          # value * 10^4, exact
    return (minor4 * (10 ** decimals) + 5000) // 10000  # round half up


def slugify(text):
    ascii_text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return s[:40] or "restaurant"


def unique_slug(name):
    base = slugify(name)
    slug, n = base, 2
    while db.q1("SELECT 1 FROM restaurants WHERE slug = ?", (slug,)):
        slug = "%s-%d" % (base, n)
        n += 1
    return slug


HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


# ---------------------------------------------------------------- time

def tzinfo_for(rest):
    name = (rest["timezone"] if rest and "timezone" in rest.keys() else "") or ""
    if name and ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return datetime.now().astimezone().tzinfo


def valid_timezone(name):
    if not name:
        return True
    if ZoneInfo is None:
        return False
    try:
        ZoneInfo(name)
        return True
    except Exception:
        return False


def local_now(rest):
    return datetime.now(tzinfo_for(rest))


def local_day_start(rest, days_ago=0):
    """Unix ts of local midnight `days_ago` days back."""
    tz = tzinfo_for(rest)
    d = datetime.now(tz).date() - timedelta(days=days_ago)
    return int(datetime(d.year, d.month, d.day, tzinfo=tz).timestamp())


def in_window(frm, to, rest):
    """Category time window check. '' means always. Handles overnight windows (22:00-02:00)."""
    if not frm or not to:
        return True
    n = local_now(rest)
    cur = n.hour * 60 + n.minute
    f = int(frm[:2]) * 60 + int(frm[3:])
    t = int(to[:2]) * 60 + int(to[3:])
    if f == t:
        return True
    if f < t:
        return f <= cur < t
    return cur >= f or cur < t


# ---------------------------------------------------------------- live revisions
# Every change that the kitchen / staff board should notice bumps a per-restaurant
# counter. Screens poll `?rev=N` and only download the board when it moved.

_rev = {}
_rev_lock = threading.Condition()


def bump(restaurant_id):
    with _rev_lock:
        _rev[restaurant_id] = _rev.get(restaurant_id, 0) + 1
        _rev_lock.notify_all()


def current_rev(restaurant_id):
    with _rev_lock:
        if restaurant_id not in _rev:
            # Seed from time so a server restart never looks like "no change" to an open screen.
            _rev[restaurant_id] = int(time.time() * 10) % 1_000_000_000
        return _rev[restaurant_id]


def wait_for_change(restaurant_id, since, timeout=20.0):
    """Long-poll: block until the revision differs from `since` or timeout. Returns current rev."""
    deadline = time.monotonic() + timeout
    with _rev_lock:
        if restaurant_id not in _rev:
            _rev[restaurant_id] = int(time.time() * 10) % 1_000_000_000
        while _rev[restaurant_id] == since:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            _rev_lock.wait(left)
        return _rev[restaurant_id]


# ---------------------------------------------------------------- restaurant

def get_restaurant(rid):
    return db.q1("SELECT * FROM restaurants WHERE id = ?", (rid,))


def subscription_ok(rest):
    if rest is None or rest["status"] != "active":
        return False
    if rest["paid_until"] and rest["paid_until"] < db.now():
        return False
    return True


def ordering_open(rest):
    return subscription_ok(rest) and bool(rest["ordering_enabled"])


def public_restaurant(rest):
    return {
        "name": rest["name"], "slug": rest["slug"], "tagline": rest["tagline"],
        "phone": rest["phone"], "address": rest["address"],
        "wifi_name": rest["wifi_name"], "wifi_password": rest["wifi_password"],
        "logo": rest["logo"], "cover": rest["cover"], "accent": rest["accent"],
        "currency": rest["currency"], "currency_symbol": rest["currency_symbol"],
        "currency_suffix": bool(rest["currency_suffix"]), "decimals": rest["decimals"],
        "tax_rate": rest["tax_rate"], "tax_inclusive": bool(rest["tax_inclusive"]),
        "service_rate": rest["service_rate"], "language": rest["language"],
        "ordering_open": ordering_open(rest), "available": subscription_ok(rest),
        "closed_message": rest["closed_message"], "require_name": bool(rest["require_name"]),
    }


def create_restaurant(name, **fields):
    ts = db.now()
    rid = db.run(
        "INSERT INTO restaurants(slug, name, created_at) VALUES(?,?,?)",
        (unique_slug(name), clean_text(name, 80) or "My Restaurant", ts))
    if fields:
        db.update_fields("restaurants", rid, fields)
    return rid


# ---------------------------------------------------------------- menu

def normalize_options(raw, decimals=2):
    """Validate option groups coming from the admin editor.

    Output: [{id, name, type: single|multi, required: bool, max: int, choices: [{id, name, price}]}]
    `price` in minor units; accepted as minor int (`price`) or display string (`price_display`)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            raise ServiceError("Options are not valid JSON", "bad_options")
    if not isinstance(raw, list):
        raise ServiceError("Options must be a list", "bad_options")
    out = []
    for g in raw[:12]:
        if not isinstance(g, dict):
            continue
        name = clean_text(g.get("name"), 60)
        if not name:
            raise ServiceError("Every option group needs a name", "bad_options")
        gtype = "multi" if g.get("type") == "multi" else "single"
        choices = []
        for ch in (g.get("choices") or [])[:30]:
            if not isinstance(ch, dict):
                continue
            cname = clean_text(ch.get("name"), 60)
            if not cname:
                continue
            if "price_display" in ch:
                price = money_to_minor(ch.get("price_display") or 0, decimals)
            else:
                price = to_int(ch.get("price"), 0, 0, 10 ** 9)
            cid = clean_text(ch.get("id"), 12) or short_id()
            choices.append({"id": cid, "name": cname, "price": price})
        if not choices:
            raise ServiceError("Option group '%s' has no choices" % name, "bad_options")
        # ids must be unique inside a group
        seen = set()
        for ch in choices:
            while ch["id"] in seen:
                ch["id"] = short_id()
            seen.add(ch["id"])
        out.append({
            "id": clean_text(g.get("id"), 12) or short_id(),
            "name": name, "type": gtype,
            "required": bool(g.get("required")),
            "max": to_int(g.get("max"), 0, 0, len(choices)) if gtype == "multi" else 1,
            "choices": choices,
        })
    seen = set()
    for g in out:
        while g["id"] in seen:
            g["id"] = short_id()
        seen.add(g["id"])
    return out


def clean_list(values, allowed):
    if isinstance(values, str):
        values = [v.strip() for v in values.split(",")]
    if not isinstance(values, list):
        return []
    return [v for v in dict.fromkeys(str(x).strip().lower() for x in values) if v in allowed]


def load_menu(rid, include_hidden=False):
    cats = db.rows_dicts(db.q(
        "SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort, id", (rid,)))
    items = db.rows_dicts(db.q(
        "SELECT * FROM items WHERE restaurant_id = ? ORDER BY sort, id", (rid,)),
        json_fields=("tags", "allergens", "options"))
    if not include_hidden:
        cats = [c for c in cats if c["visible"]]
        items = [i for i in items if i["visible"]]
    return cats, items


def public_menu(rest):
    cats, items = load_menu(rest["id"])
    by_cat = {}
    for it in items:
        by_cat.setdefault(it["category_id"], []).append({
            "id": it["id"], "name": it["name"], "description": it["description"],
            "price": it["price"], "compare_price": it["compare_price"],
            "image": it["image"], "emoji": it["emoji"], "tags": it["tags"],
            "allergens": it["allergens"], "calories": it["calories"],
            "prep_minutes": it["prep_minutes"], "options": it["options"],
            "available": bool(it["available"]),
        })
    out = []
    for c in cats:
        its = by_cat.get(c["id"], [])
        if not its:
            continue
        out.append({
            "id": c["id"], "name": c["name"], "description": c["description"], "icon": c["icon"],
            "open": in_window(c["available_from"], c["available_to"], rest),
            "hours": ("%s–%s" % (c["available_from"], c["available_to"])) if c["available_from"] and c["available_to"] else "",
            "items": its,
        })
    # Categories being served right now come first (breakfast shouldn't greet dinner guests).
    out.sort(key=lambda c: not c["open"])
    return out


# ---------------------------------------------------------------- pricing

def compute_totals(subtotal, rest):
    service = (subtotal * rest["service_rate"] + 5000) // 10000
    rate = rest["tax_rate"]
    if rate <= 0:
        tax = 0
        total = subtotal + service
    elif rest["tax_inclusive"]:
        base = subtotal + service
        tax = base - (base * 10000 + (10000 + rate) // 2) // (10000 + rate)
        total = base
    else:
        tax = ((subtotal + service) * rate + 5000) // 10000
        total = subtotal + service + tax
    return {"subtotal": subtotal, "service": service, "tax": tax, "total": total}


def price_lines(rest, lines):
    """Validate a cart against the live menu. Returns (priced_lines, totals). Raises ServiceError."""
    if not isinstance(lines, list) or not lines:
        raise ServiceError("Your cart is empty", "empty_cart")
    if len(lines) > MAX_LINES:
        raise ServiceError("Too many different items in one order", "too_many")
    ids = {to_int(l.get("item_id")) for l in lines if isinstance(l, dict)}
    ids.discard(0)
    if not ids:
        raise ServiceError("Your cart is empty", "empty_cart")
    marks = ",".join("?" * len(ids))
    rows = db.q(
        "SELECT i.*, c.visible AS cat_visible, c.available_from, c.available_to, c.name AS cat_name "
        "FROM items i JOIN categories c ON c.id = i.category_id "
        "WHERE i.restaurant_id = ? AND i.id IN (%s)" % marks, [rest["id"], *ids])
    menu = {r["id"]: r for r in rows}

    priced, subtotal, total_qty = [], 0, 0
    for l in lines:
        if not isinstance(l, dict):
            raise ServiceError("Invalid cart line", "bad_cart")
        iid = to_int(l.get("item_id"))
        it = menu.get(iid)
        if it is None or not it["visible"] or not it["cat_visible"]:
            raise ServiceError("An item in your cart is no longer on the menu", "item_gone", item_id=iid)
        if not it["available"]:
            raise ServiceError("%s is sold out" % it["name"], "sold_out", item_id=iid, item=it["name"])
        if not in_window(it["available_from"], it["available_to"], rest):
            raise ServiceError("%s is not served right now" % it["name"], "not_now", item_id=iid, item=it["name"])
        qty = to_int(l.get("qty"), 0)
        if qty < 1 or qty > MAX_QTY:
            raise ServiceError("Invalid quantity for %s" % it["name"], "bad_qty", item_id=iid)
        total_qty += qty

        groups = json.loads(it["options"] or "[]")
        chosen = l.get("options") or {}
        if not isinstance(chosen, dict):
            raise ServiceError("Invalid options for %s" % it["name"], "bad_options", item_id=iid)
        gmap = {g["id"]: g for g in groups}
        for gid in chosen:
            if gid not in gmap:
                raise ServiceError("The options for %s changed, please re-add it" % it["name"],
                                   "options_changed", item_id=iid, item=it["name"])
        unit = it["price"]
        picked = []
        for g in groups:
            sel = chosen.get(g["id"]) or []
            if isinstance(sel, str):
                sel = [sel]
            if not isinstance(sel, list):
                raise ServiceError("Invalid options for %s" % it["name"], "bad_options", item_id=iid)
            sel = list(dict.fromkeys(str(s) for s in sel))
            cmap = {c["id"]: c for c in g["choices"]}
            if any(s not in cmap for s in sel):
                raise ServiceError("The options for %s changed, please re-add it" % it["name"],
                                   "options_changed", item_id=iid, item=it["name"])
            if g["type"] == "single" and len(sel) > 1:
                raise ServiceError("Choose only one %s" % g["name"], "bad_options", item_id=iid)
            if g["type"] == "multi" and g.get("max") and len(sel) > g["max"]:
                raise ServiceError("Choose up to %d for %s" % (g["max"], g["name"]), "bad_options", item_id=iid)
            if g.get("required") and not sel:
                raise ServiceError("Please choose %s for %s" % (g["name"], it["name"]),
                                   "option_required", item_id=iid, item=it["name"], group=g["name"])
            for s in sel:
                c = cmap[s]
                unit += c["price"]
                picked.append({"group": g["name"], "choice": c["name"], "price": c["price"]})
        line_total = unit * qty
        subtotal += line_total
        priced.append({
            "item_id": iid, "name": it["name"], "unit_price": unit, "qty": qty,
            "options": picked, "note": clean_text(l.get("note"), 200), "line_total": line_total,
        })
    if total_qty > MAX_TOTAL_QTY:
        raise ServiceError("That is a very large order - please ask a waiter", "too_many")
    return priced, compute_totals(subtotal, rest)


# ---------------------------------------------------------------- orders

def _next_number(c, rest_id, rest):
    day = local_now(rest).strftime("%Y-%m-%d")
    row = c.execute("SELECT order_seq_day, order_seq FROM restaurants WHERE id = ?", (rest_id,)).fetchone()
    seq = row["order_seq"] + 1 if row["order_seq_day"] == day else 1
    c.execute("UPDATE restaurants SET order_seq_day = ?, order_seq = ? WHERE id = ?", (day, seq, rest_id))
    return seq


def place_order(table, payload, client_ip=""):
    rest = get_restaurant(table["restaurant_id"])
    if not subscription_ok(rest):
        raise ServiceError("This menu is currently unavailable", "unavailable", 403)
    if not rest["ordering_enabled"]:
        raise ServiceError(rest["closed_message"] or "Ordering is closed right now", "closed", 403)
    if not table["active"]:
        raise ServiceError("This table is not taking orders", "table_inactive", 403)

    priced, totals = price_lines(rest, payload.get("items"))
    name = clean_text(payload.get("name"), 60)
    if rest["require_name"] and not name:
        raise ServiceError("Please enter your name", "name_required")
    note = clean_text(payload.get("note"), 300)
    ts = db.now()
    status = "preparing" if rest["auto_accept"] else "new"
    token = new_token(12)

    with db.tx() as c:
        number = _next_number(c, rest["id"], rest)
        cur = c.execute(
            "INSERT INTO orders(restaurant_id, table_id, table_label, number, public_token, status, "
            "customer_name, note, subtotal, tax, service, total, item_count, client_ip, created_at, "
            "updated_at, preparing_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rest["id"], table["id"], table["label"], number, token, status, name, note,
             totals["subtotal"], totals["tax"], totals["service"], totals["total"],
             sum(p["qty"] for p in priced), client_ip[:64], ts, ts,
             ts if status == "preparing" else None))
        oid = cur.lastrowid
        c.executemany(
            "INSERT INTO order_items(order_id, item_id, name, unit_price, qty, options, note, line_total) "
            "VALUES(?,?,?,?,?,?,?,?)",
            [(oid, p["item_id"], p["name"], p["unit_price"], p["qty"],
              json.dumps(p["options"], ensure_ascii=False), p["note"], p["line_total"]) for p in priced])
    bump(rest["id"])
    return order_detail(oid)


def order_detail(oid, restaurant_id=None):
    sql = "SELECT * FROM orders WHERE id = ?"
    args = [oid]
    if restaurant_id is not None:
        sql += " AND restaurant_id = ?"
        args.append(restaurant_id)
    o = db.row_dict(db.q1(sql, args))
    if o is None:
        return None
    o["items"] = db.rows_dicts(db.q(
        "SELECT id, item_id, name, unit_price, qty, options, note, line_total "
        "FROM order_items WHERE order_id = ? ORDER BY id", (oid,)), json_fields=("options",))
    return o


def public_order(o):
    """What a customer may see about their own order (no IP, no internal ids)."""
    return {
        "token": o["public_token"], "number": o["number"], "status": o["status"],
        "table": o["table_label"], "name": o["customer_name"], "note": o["note"],
        "subtotal": o["subtotal"], "tax": o["tax"], "service": o["service"], "total": o["total"],
        "paid": bool(o["paid"]), "created_at": o["created_at"], "ready_at": o["ready_at"],
        "served_at": o["served_at"], "cancel_reason": o["cancel_reason"],
        "items": [{"name": i["name"], "qty": i["qty"], "unit_price": i["unit_price"],
                   "options": i["options"], "note": i["note"], "line_total": i["line_total"]}
                  for i in o["items"]],
    }


def set_status(rest_id, oid, status, reason=""):
    if status not in STATUSES:
        raise ServiceError("Unknown status", "bad_status")
    o = db.q1("SELECT * FROM orders WHERE id = ? AND restaurant_id = ?", (oid, rest_id))
    if o is None:
        raise ServiceError("Order not found", "not_found", 404)
    if o["status"] == status:
        return order_detail(oid)
    ts = db.now()
    fields = {"status": status, "updated_at": ts}
    stamp = {"preparing": "preparing_at", "ready": "ready_at", "served": "served_at", "cancelled": "cancelled_at"}.get(status)
    if stamp and not o[stamp]:
        fields[stamp] = ts
    if status == "cancelled":
        fields["cancel_reason"] = clean_text(reason, 200)
    elif o["status"] == "cancelled":
        fields["cancel_reason"] = ""
        fields["cancelled_at"] = None
    db.update_fields("orders", oid, fields)
    bump(rest_id)
    return order_detail(oid)


def set_paid(rest_id, oid, paid, method=""):
    o = db.q1("SELECT id FROM orders WHERE id = ? AND restaurant_id = ?", (oid, rest_id))
    if o is None:
        raise ServiceError("Order not found", "not_found", 404)
    method = method if method in PAYMENT_METHODS else ("cash" if paid else "")
    db.update_fields("orders", oid, {
        "paid": 1 if paid else 0, "payment_method": method if paid else "",
        "paid_at": db.now() if paid else None, "updated_at": db.now()})
    bump(rest_id)
    return order_detail(oid)


def board(rest_id, include_recent_minutes=90):
    """Everything a live screen needs: active orders (+ recently finished) and open calls."""
    since = db.now() - include_recent_minutes * 60
    rows = db.q(
        "SELECT * FROM orders WHERE restaurant_id = ? AND (status IN ('new','preparing','ready') "
        "OR (updated_at >= ? AND status IN ('served','cancelled'))) ORDER BY created_at",
        (rest_id, since))
    orders = db.rows_dicts(rows)
    if orders:
        ids = [o["id"] for o in orders]
        marks = ",".join("?" * len(ids))
        lines = db.rows_dicts(db.q(
            "SELECT id, order_id, item_id, name, unit_price, qty, options, note, line_total "
            "FROM order_items WHERE order_id IN (%s) ORDER BY id" % marks, ids), json_fields=("options",))
        by = {}
        for l in lines:
            by.setdefault(l["order_id"], []).append(l)
        for o in orders:
            o["items"] = by.get(o["id"], [])
            o.pop("client_ip", None)
    calls = db.rows_dicts(db.q(
        "SELECT * FROM calls WHERE restaurant_id = ? AND resolved_at IS NULL ORDER BY created_at", (rest_id,)))
    return {"orders": orders, "calls": calls, "server_time": db.now()}


# ---------------------------------------------------------------- calls

def create_call(table, kind, payment_hint=""):
    if kind not in ("waiter", "bill"):
        raise ServiceError("Unknown request", "bad_call")
    rest = get_restaurant(table["restaurant_id"])
    if not subscription_ok(rest):
        raise ServiceError("This menu is currently unavailable", "unavailable", 403)
    # Collapse repeated taps: one open call per table and kind.
    existing = db.q1(
        "SELECT id FROM calls WHERE table_id = ? AND kind = ? AND resolved_at IS NULL", (table["id"], kind))
    if existing:
        return existing["id"], False
    cid = db.run(
        "INSERT INTO calls(restaurant_id, table_id, table_label, kind, payment_hint, created_at) VALUES(?,?,?,?,?,?)",
        (rest["id"], table["id"], table["label"], kind,
         payment_hint if payment_hint in PAYMENT_METHODS else "", db.now()))
    bump(rest["id"])
    return cid, True


def resolve_call(rest_id, call_id, by=""):
    n = db.update_fields("calls", call_id, {"resolved_at": db.now(), "resolved_by": by[:80]},
                         "AND restaurant_id = ? AND resolved_at IS NULL", (rest_id,))
    if n:
        bump(rest_id)
    return n


# ---------------------------------------------------------------- reports

def report(rest, days=1):
    """Sales report for the last `days` local days (1 = today)."""
    rid = rest["id"]
    start = local_day_start(rest, days - 1)
    prev_start = local_day_start(rest, 2 * days - 1)
    tz = tzinfo_for(rest)

    orders = db.q(
        "SELECT id, status, total, subtotal, tax, service, item_count, paid, payment_method, table_label, "
        "created_at, ready_at, served_at FROM orders WHERE restaurant_id = ? AND created_at >= ?",
        (rid, start))
    live = [o for o in orders if o["status"] != "cancelled"]
    revenue = sum(o["total"] for o in live)
    prev = db.q1(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS rev FROM orders "
        "WHERE restaurant_id = ? AND created_at >= ? AND created_at < ? AND status != 'cancelled'",
        (rid, prev_start, start))

    prep = [o["ready_at"] - o["created_at"] for o in live if o["ready_at"] and o["ready_at"] >= o["created_at"]]
    by_hour = [0] * 24
    by_hour_rev = [0] * 24
    by_day = {}
    for o in live:
        dt = datetime.fromtimestamp(o["created_at"], tz)
        by_hour[dt.hour] += 1
        by_hour_rev[dt.hour] += o["total"]
        k = dt.strftime("%Y-%m-%d")
        by_day[k] = by_day.get(k, 0) + o["total"]
    days_series = []
    for i in range(days - 1, -1, -1):
        d = (datetime.now(tz).date() - timedelta(days=i)).strftime("%Y-%m-%d")
        days_series.append({"day": d, "revenue": by_day.get(d, 0)})

    top = db.rows_dicts(db.q(
        "SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total) AS revenue FROM order_items oi "
        "JOIN orders o ON o.id = oi.order_id WHERE o.restaurant_id = ? AND o.created_at >= ? "
        "AND o.status != 'cancelled' GROUP BY oi.name ORDER BY qty DESC, revenue DESC LIMIT 10",
        (rid, start)))
    tables = {}
    for o in live:
        t = tables.setdefault(o["table_label"] or "—", {"table": o["table_label"] or "—", "orders": 0, "revenue": 0})
        t["orders"] += 1
        t["revenue"] += o["total"]
    pay = {}
    for o in live:
        if o["paid"]:
            m = o["payment_method"] or "other"
            pay[m] = pay.get(m, 0) + o["total"]

    return {
        "days": days,
        "revenue": revenue,
        "orders": len(live),
        "avg_order": revenue // len(live) if live else 0,
        "items_sold": sum(o["item_count"] for o in live),
        "cancelled": sum(1 for o in orders if o["status"] == "cancelled"),
        "unpaid": sum(o["total"] for o in live if not o["paid"]),
        "unpaid_count": sum(1 for o in live if not o["paid"]),
        "tax": sum(o["tax"] for o in live),
        "service": sum(o["service"] for o in live),
        "avg_prep_seconds": sum(prep) // len(prep) if prep else 0,
        "prev_revenue": prev["rev"], "prev_orders": prev["n"],
        "by_hour": by_hour, "by_hour_revenue": by_hour_rev,
        "by_day": days_series,
        "top_items": top,
        "top_tables": sorted(tables.values(), key=lambda t: -t["revenue"])[:8],
        "payments": pay,
    }
