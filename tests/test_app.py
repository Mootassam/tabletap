"""End-to-end API tests for TableTap (stdlib unittest, isolated temp database).

    python -m unittest discover -s tests -v
"""
import json
import os
import re
import sys
import tempfile
import unittest

TMP = tempfile.mkdtemp(prefix="tabletap-test-")
os.environ["TABLETAP_DATA"] = TMP
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import server  # noqa: E402
import services as svc  # noqa: E402


def csrf_of(client, path="/login"):
    html = client.get(path).get_data(as_text=True)
    m = re.search(r'"csrf":\s*"([^"]+)"', html)
    return m.group(1) if m else None


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.app.config["TESTING"] = True
        # fresh DB per test class
        db.set_db_path(os.path.join(TMP, "t-%s.db" % cls.__name__))
        db.init()
        for lim in (server.login_limit_ip, server.login_limit_email, server.order_limit_table,
                    server.order_limit_ip, server.call_limit_table, server.public_read_limit):
            lim._hits.clear()
        cls.owner = server.app.test_client()
        tok = csrf_of(cls.owner, "/setup")
        r = cls.owner.post("/api/setup", json={
            "restaurant": "Test Bistro", "name": "Owner", "email": "owner@test.io",
            "password": "supersecret", "currency": "USD", "language": "en", "demo": True,
        }, headers={"X-CSRF-Token": tok})
        assert r.status_code == 200, r.get_data(as_text=True)
        cls.csrf = cls.boot(cls.owner)["csrf"]
        cls.rid = db.q1("SELECT id FROM restaurants")["id"]

    def setUp(self):
        for lim in (server.order_limit_table, server.order_limit_ip, server.call_limit_table, server.public_read_limit):
            lim._hits.clear()

    @staticmethod
    def boot(client, path="/admin"):
        html = client.get(path).get_data(as_text=True)
        m = re.search(r'<script id="boot" type="application/json">(.*?)</script>', html, re.S)
        return json.loads(m.group(1))

    def api(self, method, url, data=None, client=None, csrf=None):
        client = client or self.owner
        headers = {"X-CSRF-Token": csrf if csrf is not None else self.csrf}
        return client.open(url, method=method, json=data, headers=headers)

    def table(self, n=0):
        return db.q("SELECT * FROM tables WHERE restaurant_id = ? ORDER BY id", (self.rid,))[n]

    def item(self, name):
        return db.q1("SELECT * FROM items WHERE name = ?", (name,))


class TestSetupAuth(Base):
    def test_setup_only_once(self):
        c = server.app.test_client()
        tok = csrf_of(c, "/login")
        r = c.post("/api/setup", json={"restaurant": "X", "email": "x@x.io", "password": "12345678"},
                   headers={"X-CSRF-Token": tok})
        self.assertEqual(r.status_code, 400)

    def test_csrf_required_on_writes(self):
        r = self.api("POST", "/api/a/categories", {"name": "Nope"}, csrf="wrong")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["code"], "csrf")

    def test_login_wrong_password_and_rate_limit(self):
        c = server.app.test_client()
        tok = csrf_of(c)
        codes = [c.post("/api/auth/login", json={"email": "owner@test.io", "password": "bad"},
                        headers={"X-CSRF-Token": tok}).status_code for _ in range(10)]
        self.assertEqual(codes[0], 401)
        self.assertIn(429, codes)

    def test_anonymous_blocked(self):
        c = server.app.test_client()
        self.assertEqual(c.get("/api/a/menu").status_code, 401)
        self.assertEqual(c.get("/admin").status_code, 302)

    def test_security_headers(self):
        r = self.owner.get("/admin")
        self.assertIn("default-src 'self'", r.headers["Content-Security-Policy"])
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")


class TestOrdering(Base):
    def place(self, items, token=None, **extra):
        token = token or self.table()["token"]
        c = server.app.test_client()
        return c.post("/api/p/order/" + token, json={"items": items, **extra})

    def test_menu_page_renders(self):
        t = self.table()
        r = server.app.test_client().get("/t/" + t["token"])
        self.assertEqual(r.status_code, 200)
        data = self.boot(server.app.test_client(), "/t/" + t["token"])
        self.assertEqual(data["table"]["label"], t["label"])
        self.assertTrue(len(data["menu"]) >= 4)
        self.assertNotIn("password_hash", r.get_data(as_text=True))

    def test_unknown_table_404(self):
        self.assertEqual(server.app.test_client().get("/t/nope").status_code, 404)

    def test_server_reprices_and_ignores_client_price(self):
        it = self.item("Espresso")  # 2.50, no options
        r = self.place([{"item_id": it["id"], "qty": 3, "price": 1, "unit_price": 1}])
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        o = r.get_json()["order"]
        self.assertEqual(o["subtotal"], 750)
        self.assertEqual(o["total"], 750)

    def test_required_option_enforced(self):
        it = self.item("Chicken Wings")
        r = self.place([{"item_id": it["id"], "qty": 1}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["code"], "option_required")

    def test_options_priced_correctly(self):
        it = self.item("Chicken Wings")  # 10 + 12 wings (+8)
        groups = json.loads(it["options"])
        sauce = groups[0]
        portion = groups[1]
        big = next(c for c in portion["choices"] if c["name"] == "12 wings")
        r = self.place([{"item_id": it["id"], "qty": 2,
                         "options": {sauce["id"]: [sauce["choices"][0]["id"]], portion["id"]: [big["id"]]}}])
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        o = r.get_json()["order"]
        self.assertEqual(o["subtotal"], (1000 + 800) * 2)
        self.assertEqual(o["items"][0]["options"][1]["choice"], "12 wings")

    def test_single_choice_group_rejects_two(self):
        it = self.item("Chicken Wings")
        g = json.loads(it["options"])
        r = self.place([{"item_id": it["id"], "qty": 1, "options": {
            g[0]["id"]: [g[0]["choices"][0]["id"], g[0]["choices"][1]["id"]], g[1]["id"]: [g[1]["choices"][0]["id"]]}}])
        self.assertEqual(r.status_code, 400)

    def test_multi_max_enforced(self):
        it = self.item("Gelato")
        g = json.loads(it["options"])[0]
        r = self.place([{"item_id": it["id"], "qty": 1, "options": {g["id"]: [c["id"] for c in g["choices"][:3]]}}])
        self.assertEqual(r.status_code, 400)

    def test_fake_option_ids_rejected(self):
        it = self.item("Espresso")
        r = self.place([{"item_id": it["id"], "qty": 1, "options": {"zzz": ["yyy"]}}])
        self.assertEqual(r.get_json()["code"], "options_changed")

    def test_bad_quantities(self):
        it = self.item("Espresso")
        for q in (0, -1, 51, "abc"):
            r = self.place([{"item_id": it["id"], "qty": q}])
            self.assertEqual(r.status_code, 400, q)

    def test_sold_out_blocked(self):
        it = self.item("Tiramisu")
        db.run("UPDATE items SET available = 0 WHERE id = ?", (it["id"],))
        r = self.place([{"item_id": it["id"], "qty": 1}])
        self.assertEqual(r.get_json()["code"], "sold_out")
        db.run("UPDATE items SET available = 1 WHERE id = ?", (it["id"],))

    def test_item_from_other_restaurant_rejected(self):
        other = svc.create_restaurant("Other Place")
        cid = db.run("INSERT INTO categories(restaurant_id, name) VALUES(?, 'C')", (other,))
        iid = db.run("INSERT INTO items(restaurant_id, category_id, name, price, created_at, updated_at) "
                     "VALUES(?,?,?,?,?,?)", (other, cid, "Foreign", 100, 0, 0))
        r = self.place([{"item_id": iid, "qty": 1}])
        self.assertEqual(r.get_json()["code"], "item_gone")

    def test_ordering_closed(self):
        db.run("UPDATE restaurants SET ordering_enabled = 0 WHERE id = ?", (self.rid,))
        it = self.item("Espresso")
        r = self.place([{"item_id": it["id"], "qty": 1}])
        self.assertEqual(r.status_code, 403)
        db.run("UPDATE restaurants SET ordering_enabled = 1 WHERE id = ?", (self.rid,))

    def test_expired_subscription_blocks(self):
        db.run("UPDATE restaurants SET paid_until = 1 WHERE id = ?", (self.rid,))
        it = self.item("Espresso")
        r = self.place([{"item_id": it["id"], "qty": 1}])
        self.assertEqual(r.get_json()["code"], "unavailable")
        data = self.boot(server.app.test_client(), "/t/" + self.table()["token"])
        self.assertEqual(data["menu"], [])
        db.run("UPDATE restaurants SET paid_until = NULL WHERE id = ?", (self.rid,))

    def test_tax_and_service(self):
        db.run("UPDATE restaurants SET tax_rate = 1000, tax_inclusive = 0, service_rate = 500 WHERE id = ?", (self.rid,))
        it = self.item("Margherita")
        g = json.loads(it["options"])[0]
        r = self.place([{"item_id": it["id"], "qty": 1, "options": {g["id"]: [g["choices"][0]["id"]]}}], token=self.table(2)["token"])
        o = r.get_json()["order"]
        self.assertEqual(o["subtotal"], 1100)
        self.assertEqual(o["service"], 55)
        self.assertEqual(o["tax"], 116)          # 10% of 1155 = 115.5 -> 116
        self.assertEqual(o["total"], 1100 + 55 + 116)
        db.run("UPDATE restaurants SET tax_rate = 1000, tax_inclusive = 1, service_rate = 0 WHERE id = ?", (self.rid,))
        r = self.place([{"item_id": it["id"], "qty": 1, "options": {g["id"]: [g["choices"][0]["id"]]}}], token=self.table(2)["token"])
        o = r.get_json()["order"]
        self.assertEqual(o["total"], 1100)
        self.assertEqual(o["tax"], 100)          # 1100 - 1100/1.1
        db.run("UPDATE restaurants SET tax_rate = 0, service_rate = 0 WHERE id = ?", (self.rid,))

    def test_order_numbers_increment_and_tracking(self):
        it = self.item("Espresso")
        t = self.table(3)["token"]
        a = self.place([{"item_id": it["id"], "qty": 1}], token=t).get_json()["order"]
        b = self.place([{"item_id": it["id"], "qty": 1}], token=t).get_json()["order"]
        self.assertEqual(b["number"], a["number"] + 1)
        r = server.app.test_client().get("/api/p/orders?tokens=%s,%s,bogus" % (a["token"], b["token"]))
        got = r.get_json()["orders"]
        self.assertEqual(len(got), 2)
        self.assertNotIn("client_ip", got[0])

    def test_order_rate_limit(self):
        it = self.item("Espresso")
        t = self.table(5)["token"]
        codes = [self.place([{"item_id": it["id"], "qty": 1}], token=t).status_code for _ in range(25)]
        self.assertIn(429, codes)

    def test_calls_deduplicated(self):
        t = self.table(6)["token"]
        c = server.app.test_client()
        r1 = c.post("/api/p/call/" + t, json={"kind": "waiter"}).get_json()
        r2 = c.post("/api/p/call/" + t, json={"kind": "waiter"}).get_json()
        self.assertTrue(r1["created"])
        self.assertFalse(r2["created"])
        board = self.api("GET", "/api/s/board").get_json()
        self.assertTrue(any(x["kind"] == "waiter" for x in board["calls"]))

    def test_status_flow_and_payment(self):
        it = self.item("Espresso")
        tbl = self.table(7)
        o = self.place([{"item_id": it["id"], "qty": 2}], token=tbl["token"]).get_json()["order"]
        oid = db.q1("SELECT id FROM orders WHERE public_token = ?", (o["token"],))["id"]
        for st in ("preparing", "ready", "served"):
            r = self.api("POST", "/api/s/orders/%d/status" % oid, {"status": st})
            self.assertEqual(r.get_json()["order"]["status"], st)
        row = db.q1("SELECT * FROM orders WHERE id = ?", (oid,))
        self.assertTrue(row["preparing_at"] and row["ready_at"] and row["served_at"])
        r = self.api("POST", "/api/s/tables/%d/settle" % tbl["id"], {"method": "card"})
        self.assertGreaterEqual(r.get_json()["settled"], 1)
        self.assertEqual(db.q1("SELECT paid, payment_method FROM orders WHERE id = ?", (oid,))["payment_method"], "card")
        # prints render
        self.assertEqual(self.owner.get("/print/order/%d" % oid).status_code, 200)
        self.assertEqual(self.owner.get("/print/order/%d?kind=bill" % oid).status_code, 200)
        self.assertEqual(self.owner.get("/print/table/%d" % tbl["id"]).status_code, 200)


class TestAdmin(Base):
    def test_item_crud_with_options(self):
        cat = db.q1("SELECT id FROM categories WHERE restaurant_id = ? LIMIT 1", (self.rid,))["id"]
        r = self.api("POST", "/api/a/items", {
            "name": "Test Dish", "price": "12,5", "category_id": cat, "tags": ["spicy", "bogus"],
            "options": [{"name": "Size", "type": "single", "required": True,
                         "choices": [{"name": "S", "price_display": "0"}, {"name": "L", "price_display": "3.25"}]}]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        it = r.get_json()["item"]
        self.assertEqual(it["price"], 1250)
        self.assertEqual(it["tags"], ["spicy"])
        self.assertEqual(it["options"][0]["choices"][1]["price"], 325)
        r = self.api("PUT", "/api/a/items/%d" % it["id"], {"price": "abc"})
        self.assertEqual(r.get_json()["field"], "price")
        r = self.api("POST", "/api/a/items/%d/duplicate" % it["id"], {})
        self.assertTrue(r.get_json()["item"]["name"].endswith("(copy)"))
        self.assertEqual(self.api("DELETE", "/api/a/items/%d" % it["id"]).status_code, 200)

    def test_category_delete_guard(self):
        cat = db.q1("SELECT id FROM categories WHERE restaurant_id = ? LIMIT 1", (self.rid,))["id"]
        r = self.api("DELETE", "/api/a/categories/%d" % cat)
        self.assertEqual(r.status_code, 409)

    def test_tables_bulk_qr_and_print(self):
        r = self.api("POST", "/api/a/tables", {"bulk": True, "prefix": "Bar", "from": 1, "to": 3, "zone": "Bar"})
        self.assertEqual(r.get_json()["created"], 3)
        t = db.q1("SELECT * FROM tables WHERE label = 'Bar 2'")
        svg = self.owner.get("/qr/%d.svg" % t["id"])
        self.assertIn(b"<svg", svg.data)
        png = self.owner.get("/qr/%d.png?download=1" % t["id"])
        self.assertTrue(png.data.startswith(b"\x89PNG"))
        self.assertIn("attachment", png.headers["Content-Disposition"])
        for style in ("card", "tent", "sticker"):
            self.assertEqual(self.owner.get("/print/qr?style=" + style).status_code, 200)
        old = t["token"]
        r = self.api("PUT", "/api/a/tables/%d" % t["id"], {"regenerate": True})
        self.assertNotEqual(r.get_json()["table"]["token"], old)
        self.assertEqual(server.app.test_client().get("/t/" + old).status_code, 404)

    def test_settings_validation(self):
        self.assertEqual(self.api("PUT", "/api/a/settings", {"accent": "red"}).get_json()["field"], "accent")
        self.assertEqual(self.api("PUT", "/api/a/settings", {"tax_rate": "150"}).get_json()["field"], "tax_rate")
        self.assertEqual(self.api("PUT", "/api/a/settings", {"timezone": "Mars/Base"}).get_json()["field"], "timezone")
        r = self.api("PUT", "/api/a/settings", {"tax_rate": "7.5", "timezone": "Africa/Casablanca", "accent": "#123456"})
        rest = r.get_json()["restaurant"]
        self.assertEqual(rest["tax_rate"], 750)
        self.assertEqual(rest["timezone"], "Africa/Casablanca")
        self.api("PUT", "/api/a/settings", {"tax_rate": "0"})

    def test_upload_reencodes(self):
        from PIL import Image
        import io
        buf = io.BytesIO()
        Image.new("RGB", (2000, 1000), "red").save(buf, "JPEG")
        buf.seek(0)
        r = self.owner.post("/api/a/upload?kind=item", data={"file": (buf, "x.jpg")},
                            headers={"X-CSRF-Token": self.csrf}, content_type="multipart/form-data")
        name = r.get_json()["name"]
        self.assertTrue(name.endswith(".webp"))
        img = Image.open(os.path.join(TMP, "uploads", name))
        self.assertLessEqual(max(img.size), 1200)
        bad = self.owner.post("/api/a/upload?kind=item", data={"file": (io.BytesIO(b"<script>"), "x.png")},
                              headers={"X-CSRF-Token": self.csrf}, content_type="multipart/form-data")
        self.assertEqual(bad.status_code, 400)

    def test_staff_roles(self):
        r = self.api("POST", "/api/a/staff", {"email": "chef@test.io", "name": "Chef", "role": "kitchen", "password": "kitchen123"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        k = server.app.test_client()
        tok = csrf_of(k)
        r = k.post("/api/auth/login", json={"email": "chef@test.io", "password": "kitchen123"}, headers={"X-CSRF-Token": tok})
        self.assertEqual(r.get_json()["redirect"], "/kitchen")
        kb = self.boot(k, "/kitchen")
        self.assertEqual(k.get("/api/a/menu").status_code, 403)
        self.assertEqual(k.get("/api/s/board").status_code, 200)
        self.assertEqual(k.get("/admin").status_code, 302)
        # kitchen cannot mark served or take payments
        it = db.q1("SELECT id FROM items WHERE name = 'Espresso'")
        o = server.app.test_client().post("/api/p/order/" + self.table(1)["token"],
                                          json={"items": [{"item_id": it["id"], "qty": 1}]}).get_json()["order"]
        oid = db.q1("SELECT id FROM orders WHERE public_token = ?", (o["token"],))["id"]
        r = k.post("/api/s/orders/%d/status" % oid, json={"status": "served"}, headers={"X-CSRF-Token": kb["csrf"]})
        self.assertEqual(r.status_code, 403)
        r = k.post("/api/s/orders/%d/status" % oid, json={"status": "ready"}, headers={"X-CSRF-Token": kb["csrf"]})
        self.assertEqual(r.status_code, 200)
        r = k.post("/api/s/orders/%d/pay" % oid, json={"paid": True}, headers={"X-CSRF-Token": kb["csrf"]})
        self.assertEqual(r.status_code, 403)
        # disabling the account kills the session
        uid = db.q1("SELECT id FROM users WHERE email = 'chef@test.io'")["id"]
        self.api("PUT", "/api/a/staff/%d" % uid, {"active": False})
        self.assertEqual(k.get("/api/s/board").status_code, 401)

    def test_report_and_csv(self):
        r = self.api("GET", "/api/a/report?days=7").get_json()["report"]
        self.assertIn("by_day", r)
        self.assertEqual(len(r["by_day"]), 7)
        csv_resp = self.owner.get("/api/a/orders.csv?days=30")
        self.assertIn("Order #", csv_resp.get_data(as_text=True))


class TestPlatform(Base):
    def test_multi_tenant_isolation(self):
        r = self.api("POST", "/api/platform/restaurants", {
            "name": "Second Cafe", "currency": "EUR", "manager_email": "m2@test.io",
            "manager_password": "manager123", "demo": True, "paid_until": "2099-12-31"})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        rid2 = r.get_json()["id"]
        m = server.app.test_client()
        tok = csrf_of(m)
        m.post("/api/auth/login", json={"email": "m2@test.io", "password": "manager123"}, headers={"X-CSRF-Token": tok})
        mb = self.boot(m)
        self.assertEqual(mb["restaurant"]["id"], rid2)
        # manager 2 can't touch restaurant 1's items or tables
        foreign_item = db.q1("SELECT id FROM items WHERE restaurant_id = ?", (self.rid,))["id"]
        foreign_table = db.q1("SELECT id FROM tables WHERE restaurant_id = ?", (self.rid,))["id"]
        h = {"X-CSRF-Token": mb["csrf"]}
        self.assertEqual(m.put("/api/a/items/%d" % foreign_item, json={"price": "1"}, headers=h).status_code, 404)
        self.assertEqual(m.delete("/api/a/tables/%d" % foreign_table, headers=h).status_code, 404)
        self.assertEqual(m.get("/qr/%d.svg" % foreign_table).status_code, 404)
        self.assertEqual(m.get("/api/platform/restaurants").status_code, 403)
        # platform can suspend it
        self.api("PUT", "/api/platform/restaurants/%d" % rid2, {"status": "suspended"})
        t2 = db.q1("SELECT token FROM tables WHERE restaurant_id = ?", (rid2,))["token"]
        data = self.boot(server.app.test_client(), "/t/" + t2)
        self.assertFalse(data["restaurant"]["available"])
        # delete requires typed confirmation
        self.assertEqual(self.api("DELETE", "/api/platform/restaurants/%d" % rid2, {"confirm": "nope"}).status_code, 400)
        self.assertEqual(self.api("DELETE", "/api/platform/restaurants/%d" % rid2, {"confirm": "Second Cafe"}).status_code, 200)
        self.assertIsNone(db.q1("SELECT 1 FROM users WHERE email = 'm2@test.io'"))

    def test_backup(self):
        r = self.owner.get("/api/platform/backup/latest")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.data.startswith(b"SQLite format 3"))


class TestUnits(unittest.TestCase):
    def test_money_parsing(self):
        self.assertEqual(svc.money_to_minor("12.5"), 1250)
        self.assertEqual(svc.money_to_minor("12,50"), 1250)
        self.assertEqual(svc.money_to_minor("0.005"), 1)
        self.assertEqual(svc.money_to_minor("7", 0), 7)
        self.assertEqual(svc.money_to_minor("1.2345", 3), 1235)
        for bad in ("-1", "abc", "1.2.3", "1e5"):
            with self.assertRaises(svc.ServiceError):
                svc.money_to_minor(bad)

    def test_time_window_overnight(self):
        self.assertTrue(svc.in_window("", "", None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
