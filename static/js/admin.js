/* TableTap admin: dashboard, live orders, menu editor, tables & QR, orders, staff, settings, platform. */
(function () {
  "use strict";
  const { h, icon, api, toast, modal, confirmDialog, store, readBoot, mount, clear, $, $$, withBusy, fieldError, clearErrors } = TT;

  const BOOT = readBoot();
  TT.setCsrf(BOOT.csrf);
  const USER = BOOT.user;
  let REST = BOOT.restaurant;
  let money = TT.moneyFormatter(REST || {});
  const TAGS = BOOT.tags;
  const ALLERGENS = BOOT.allergens;
  const CURRENCIES = BOOT.currencies;

  const isPlatform = USER.role === "platform";
  const isManager = isPlatform || USER.role === "manager";
  const TAG_LABEL = { popular: "Popular", new: "New", chef: "Chef's pick", spicy: "Spicy", veg: "Vegetarian", vegan: "Vegan", gf: "Gluten-free", halal: "Halal" };
  const STATUS_LABEL = { new: "New", preparing: "Preparing", ready: "Ready", served: "Served", cancelled: "Cancelled" };
  const STATUS_BADGE = { new: "accent", preparing: "warn", ready: "ok", served: "", cancelled: "danger" };
  const ROLE_INFO = {
    manager: ["Manager", "Everything for this restaurant: menu, tables, staff, reports, settings."],
    waiter: ["Waiter", "Live orders, payments and waiter calls. No menu or settings access."],
    kitchen: ["Kitchen", "Kitchen display only: start and finish orders, mark items sold out."],
  };

  // theme preference
  const themePref = store.get("tt_theme", "system");
  if (themePref !== "system") document.documentElement.dataset.theme = themePref;
  if (REST && REST.accent) document.documentElement.style.setProperty("--accent", REST.accent);

  // ================================================================ helpers
  const minorToInput = (minor) => (minor ? ((Number(minor) || 0) / Math.pow(10, money.decimals)).toFixed(money.decimals) : "");
  const initials = (s) => (s || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const pct = (bp) => (bp / 100).toString();

  function badge(text, kind) { return h("span.badge" + (kind ? "." + kind : ""), text); }
  function statusBadge(st) { return badge(STATUS_LABEL[st] || st, STATUS_BADGE[st]); }
  function emptyState(ic, title, text, action) {
    return h("div.empty", h("div.empty-icon", icon(ic)), h("h3", title), text ? h("p", text) : null,
      action ? h("div", { style: { marginTop: "16px" } }, action) : null);
  }
  function spinnerBlock() { return h("div", { style: { display: "grid", placeItems: "center", padding: "60px" } }, h("div.spinner")); }

  function popMenu(anchor, entries) {
    $$(".menu-pop").forEach((m) => m.remove());
    const pop = h("div.menu-pop", entries.map((e) => {
      if (e === "-") return h("hr");
      if (!e) return null;
      const tag = e.href ? "a" : "button";
      return h(tag + (e.danger ? ".danger" : ""), {
        href: e.href, target: e.target,
        onclick: (ev) => { pop.remove(); if (e.run) { ev.preventDefault(); e.run(); } },
      }, icon(e.icon), e.label);
    }));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hh = pop.offsetHeight;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    let top = r.bottom + 6 + window.scrollY;
    if (r.bottom + hh + 12 > window.innerHeight) top = r.top - hh - 6 + window.scrollY;
    Object.assign(pop.style, { left: left + "px", top: top + "px" });
    setTimeout(() => document.addEventListener("pointerdown", function off(ev) {
      if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("pointerdown", off); }
    }), 0);
  }

  // Drag-to-reorder by a .drag handle. Calls onDone(ids) with the new order.
  function sortable(container, itemSel, onDone) {
    container.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".drag");
      if (!handle || !container.contains(handle)) return;
      const item = handle.closest(itemSel);
      if (!item || item.parentElement !== container) return;
      e.preventDefault();
      const before = [...container.querySelectorAll(":scope > " + itemSel)].map((x) => x.dataset.id).join(",");
      item.classList.add("dragging");
      const move = (ev) => {
        const sibs = [...container.querySelectorAll(":scope > " + itemSel)].filter((x) => x !== item);
        let target = null;
        for (const s of sibs) {
          const r = s.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { target = s; break; }
        }
        if (target) container.insertBefore(item, target);
        else if (sibs.length) sibs[sibs.length - 1].after(item);
        if (ev.clientY < 70) window.scrollBy(0, -12);
        else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        item.classList.remove("dragging");
        const ids = [...container.querySelectorAll(":scope > " + itemSel)].map((x) => x.dataset.id);
        if (ids.join(",") !== before) onDone(ids);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
  }

  // Image picker with drag & drop and instant upload.
  function uploader({ value, kind = "item", cls = "", label = "Add a photo", onChange }) {
    let current = value || "";
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
    const box = h("div.uploader" + (cls ? "." + cls : ""), { tabindex: "0", role: "button", "aria-label": label });
    function paint(busy) {
      mount(box,
        current ? h("img", { src: "/u/" + current, alt: "" }) : null,
        busy ? h("div.spinner") : current ? null : h("div", icon("upload", "icon"), h("div", { style: { marginTop: "6px" } }, label), h("div.tiny", "JPG, PNG or WebP")),
        current && !busy ? h("div.up-actions",
          h("button.btn.btn-sm", { type: "button", onclick: (e) => { e.stopPropagation(); input.click(); } }, "Change"),
          h("button.btn.btn-sm.btn-icon", { type: "button", "aria-label": "Remove image", onclick: (e) => { e.stopPropagation(); current = ""; paint(); onChange(""); } }, icon("trash"))) : null,
        input);
    }
    async function upload(file) {
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) return toast("That image is larger than 12 MB", "error");
      paint(true);
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await api("POST", "/api/a/upload?kind=" + kind, fd);
        current = res.name;
        onChange(current);
      } catch (e) { toast(e.message, "error"); }
      paint(false);
    }
    box.addEventListener("click", () => input.click());
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => upload(input.files[0]));
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
    box.addEventListener("dragleave", () => box.classList.remove("over"));
    box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); upload(e.dataTransfer.files[0]); });
    paint();
    return box;
  }

  function switchInput(checked, onchange, label, cls) {
    const inp = h("input", { type: "checkbox", checked: !!checked, onchange: (e) => onchange(e.target.checked, e) });
    return h("label.switch" + (cls ? "." + cls : ""), inp, h("span.track"), label ? h("span", label) : null);
  }

  function field(label, control, hint) {
    return h("div.field", h("label", label), control, hint ? h("span.hint", hint) : null);
  }

  function select(name, options, value) {
    const s = h("select.select", { name }, options.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value == null ? "" : String(value);
    return s;
  }

  function handleFormError(form, e) {
    if (e.field && form && fieldError(form, e.field, e.message)) return;
    toast(e.message, "error");
  }

  // ================================================================ live store (shared by sidebar badge + Live page)
  const Live = { orders: [], calls: [], rev: -1, skew: 0, listeners: new Set(), loaded: false, seen: new Set(), sound: store.get("tt_admin_sound", true) };
  Live.now = () => Date.now() / 1000 + Live.skew;
  Live.emit = () => Live.listeners.forEach((fn) => fn());
  async function liveLoop() {
    if (!REST) return;
    for (;;) {
      try {
        const res = await api.get("/api/s/board?rev=" + Live.rev + "&wait=" + (Live.rev < 0 ? "0" : "1"));
        if (res.changed) {
          const fresh = res.orders.filter((o) => o.status === "new" && !Live.seen.has(o.id));
          const freshCalls = res.calls.filter((c) => !Live.calls.find((x) => x.id === c.id));
          if (Live.loaded && Live.sound) {
            if (fresh.length) TT.chime("order");
            else if (freshCalls.length) TT.chime("call");
          }
          if (Live.loaded && fresh.length && document.hidden && "Notification" in window && Notification.permission === "granted") {
            try { new Notification("New order at " + (fresh[0].table_label || "a table"), { body: fresh[0].items.map((l) => l.qty + "× " + l.name).join(", "), tag: "tt-order" }); } catch (_) { /* ignore */ }
          }
          res.orders.forEach((o) => Live.seen.add(o.id));
          Live.orders = res.orders;
          Live.calls = res.calls;
          Live.skew = res.server_time - Date.now() / 1000;
          Live.loaded = true;
          Live.emit();
        }
        Live.rev = res.rev;
      } catch (e) {
        if (e.status === 401 || e.status === 403) return;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  document.addEventListener("pointerdown", () => { if (Live.sound && !TT.audioReady()) TT.unlockAudio(); });

  // ================================================================ shell
  const ROUTES = [
    { id: "dashboard", title: "Dashboard", icon: "chart", manager: true, render: pageDashboard, sec: "Restaurant" },
    { id: "live", title: "Live orders", icon: "zap", render: pageLive },
    { id: "orders", title: "Order history", icon: "receipt", render: pageOrders },
    { id: "menu", title: "Menu", icon: "utensils", manager: true, render: pageMenu, sec: "Setup" },
    { id: "tables", title: "Tables & QR codes", icon: "qr", manager: true, render: pageTables },
    { id: "staff", title: "Staff", icon: "users", manager: true, render: pageStaff },
    { id: "settings", title: "Settings", icon: "settings", manager: true, render: pageSettings },
    { id: "platform", title: "All restaurants", icon: "store", platform: true, render: pagePlatform, sec: "Platform", noRest: true },
  ];
  const allowed = (r) => (!r.platform || isPlatform) && (!r.manager || isManager) && (REST || r.noRest);

  const content = h("div.content");
  const titleEl = h("h1");
  const subEl = h("div.sub");
  const actionsEl = h("div.page-actions");
  const bannerBox = h("div");
  const side = h("aside.side");
  let scrim = null;
  let cleanup = null;
  let currentRoute = null;

  function buildSide() {
    const nav = h("nav.nav");
    let lastSec = null;
    for (const r of ROUTES.filter(allowed)) {
      if (r.sec && r.sec !== lastSec) { nav.append(h("div.nav-sec", r.sec)); lastSec = r.sec; }
      nav.append(h("a", { href: "#/" + r.id, dataset: { route: r.id } }, icon(r.icon), h("span", r.title),
        r.id === "live" ? h("span.count", { hidden: true }) : null));
    }
    const restBtn = REST ? h("button.rest-switch", { onclick: (e) => isPlatform ? switchRestaurant(e.currentTarget) : (location.hash = isManager ? "#/settings" : "#/live") },
      h("span.rs-logo", REST.logo ? h("img", { src: "/u/" + REST.logo, alt: "" }) : initials(REST.name)),
      h("span", { style: { minWidth: 0 } }, h("div.rs-name.ellipsis", REST.name), h("div.rs-sub", REST.subscription_ok ? "/" + REST.slug : "Subscription inactive")),
      isPlatform ? icon("chevronDown", "chev") : null) : null;

    const openToggle = REST && isManager ? h("div.open-toggle",
      h("span.st", REST.ordering_enabled ? "Taking orders" : "Ordering paused", h("small", REST.ordering_enabled ? "Guests can order" : "Menu is browse-only")),
      switchInput(REST.ordering_enabled, async (on, e) => {
        try {
          const res = await api.put("/api/a/settings", { ordering_enabled: on });
          REST = res.restaurant;
          toast(on ? "Ordering is open" : "Ordering paused — guests can still browse", on ? "ok" : "info");
          buildSide();
        } catch (err) { e.target.checked = !on; toast(err.message, "error"); }
      }, null, "sm")) : null;

    const me = h("button.me", { onclick: (e) => userMenu(e.currentTarget) },
      h("span.avatar", initials(USER.name || USER.email)),
      h("span.who", h("b", USER.name || USER.email), h("small", USER.role === "platform" ? "Owner · platform" : USER.role)));

    mount(side,
      h("div.brand", h("span.brand-mark", icon("qr")), "TableTap"),
      restBtn, nav,
      h("div.side-foot",
        REST ? h("a.btn.btn-soft.btn-block", { href: "/kitchen", target: "_blank" }, icon("chef"), "Kitchen display") : null,
        openToggle, me));
    highlightNav();
    updateLiveCount();
  }

  function highlightNav() {
    $$(".nav a", side).forEach((a) => a.classList.toggle("active", a.dataset.route === (currentRoute && currentRoute.id)));
  }

  function updateLiveCount() {
    const el = $('.nav a[data-route="live"] .count', side);
    if (!el) return;
    const n = Live.orders.filter((o) => o.status === "new").length + Live.calls.length;
    el.hidden = !n;
    el.textContent = n;
    document.title = (n ? "(" + n + ") " : "") + (currentRoute ? currentRoute.title + " · " : "") + "TableTap";
  }
  Live.listeners.add(updateLiveCount);

  function userMenu(anchor) {
    const cycle = { system: "light", light: "dark", dark: "system" };
    const cur = store.get("tt_theme", "system");
    popMenu(anchor, [
      { icon: "key", label: "Change password", run: changePassword },
      { icon: "moon", label: "Theme: " + cur + " → " + cycle[cur], run: () => { store.set("tt_theme", cycle[cur]); location.reload(); } },
      "Notification" in window && Notification.permission === "default"
        ? { icon: "bell", label: "Desktop alerts for new orders", run: () => Notification.requestPermission() } : null,
      "-",
      { icon: "logout", label: "Sign out", href: "/logout", danger: true },
    ]);
  }

  async function switchRestaurant(anchor) {
    try {
      const res = await api.get("/api/platform/restaurants");
      popMenu(anchor, [
        ...res.restaurants.map((r) => ({
          icon: r.id === res.current ? "check" : "store", label: r.name,
          run: async () => { await api.post("/api/platform/switch", { id: r.id }); location.hash = "#/dashboard"; location.reload(); },
        })),
        "-",
        { icon: "plus", label: "New restaurant", run: () => { location.hash = "#/platform"; setTimeout(createRestaurant, 50); } },
      ]);
    } catch (e) { toast(e.message, "error"); }
  }

  function changePassword() {
    const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
      field("Current password", h("input.input", { type: "password", name: "current", autocomplete: "current-password" })),
      field("New password", h("input.input", { type: "password", name: "new", autocomplete: "new-password", minlength: 8 }), "At least 8 characters."));
    const save = h("button.btn.btn-primary", {
      onclick: () => withBusy(save, async () => {
        try {
          await api.post("/api/a/me/password", Object.fromEntries(new FormData(form)));
          m.close();
          toast("Password changed", "ok");
        } catch (e) { handleFormError(form, e); }
      }),
    }, "Change password");
    const m = modal({ title: "Change password", size: "narrow", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
  }

  function renderShell() {
    const hamb = h("button.btn.btn-ghost.btn-icon.hamb", { "aria-label": "Menu", onclick: openSide }, icon("menu"));
    mount($("#app"), h("div.shell", side,
      h("div.main",
        h("header.topbar", hamb, h("div", titleEl, subEl), actionsEl),
        bannerBox,
        content)));
    buildSide();
    if (REST && !REST.subscription_ok) {
      mount(bannerBox, h("div.alert.danger.sub-banner", icon("alert"),
        h("div", h("b", "This restaurant's subscription is inactive. "), "Guests currently see “menu unavailable”. ",
          isPlatform ? "Extend it in All restaurants." : "Contact your TableTap provider to reactivate.")));
    }
  }

  function openSide() {
    side.classList.add("open");
    scrim = h("div.side-scrim", { onclick: closeSide });
    document.body.append(scrim);
  }
  function closeSide() { side.classList.remove("open"); if (scrim) scrim.remove(); scrim = null; }

  function route() {
    const id = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "";
    const avail = ROUTES.filter(allowed);
    let r = avail.find((x) => x.id === id);
    if (!r) {
      r = avail.find((x) => x.id === (isManager ? (REST ? "dashboard" : "platform") : "live")) || avail[0];
      history.replaceState(null, "", "#/" + r.id);
    }
    if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
    currentRoute = r;
    closeSide();
    titleEl.textContent = r.title;
    subEl.textContent = "";
    clear(actionsEl);
    mount(content, spinnerBlock());
    highlightNav();
    updateLiveCount();
    window.scrollTo(0, 0);
    Promise.resolve(r.render()).then((c) => { cleanup = typeof c === "function" ? c : null; })
      .catch((e) => mount(content, emptyState("alert", "Couldn't load this page", e.message,
        h("button.btn", { onclick: route }, icon("refresh"), "Try again"))));
  }

  // ================================================================ dashboard
  async function pageDashboard() {
    let days = store.get("tt_dash_days", 1);
    const seg = h("div.seg", [[1, "Today"], [7, "7 days"], [30, "30 days"]].map(([d, l]) =>
      h("button" + (d === days ? ".on" : ""), { onclick: () => { days = d; store.set("tt_dash_days", d); $$("button", seg).forEach((b) => b.classList.toggle("on", b.textContent === l)); load(); } }, l)));
    mount(actionsEl, seg);
    subEl.textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

    const [menuRes, tablesRes] = await Promise.all([api.get("/api/a/menu"), api.get("/api/a/tables")]);
    const quick = h("div.quick-grid",
      h("a.quick", { href: "/kitchen", target: "_blank" }, h("span.ic", icon("chef")), h("span", "Kitchen display", h("small", "Open on the kitchen tablet"))),
      h("a.quick", { href: "/r/" + REST.slug, target: "_blank" }, h("span.ic", icon("eye")), h("span", "Preview guest menu", h("small", "See what guests see"))),
      h("a.quick", { href: "#/tables" }, h("span.ic", icon("printer")), h("span", "Print QR codes", h("small", tablesRes.tables.length + " tables"))),
      h("a.quick", { href: "#/menu" }, h("span.ic", icon("utensils")), h("span", "Edit menu", h("small", menuRes.items.length + " items"))));

    const steps = [
      [menuRes.items.length > 0, "Add your menu items", "#/menu"],
      [tablesRes.tables.length > 0, "Create your tables", "#/tables"],
      [!!REST.logo, "Upload your logo & cover photo", "#/settings"],
      [tablesRes.public_url_source !== "lan", "Set your public link (so guests on 4G can order)", "#/settings"],
    ];
    const todo = steps.filter((s) => !s[0]).length;
    const checklist = todo ? h("div.card.card-pad", { style: { marginBottom: "18px" } },
      h("div.panel-title", h("h3", "Finish setting up"), badge(steps.length - todo + "/" + steps.length + " done", "accent")),
      h("div.stack", { style: { gap: "8px" } }, steps.map(([done, label, href]) =>
        h("a.row", { href, style: { textDecoration: "none", padding: "6px 0" } },
          h("span", { style: { width: "24px", height: "24px", borderRadius: "50%", display: "grid", placeItems: "center", background: done ? "var(--ok)" : "var(--surface-2)", color: "#fff", flex: "none" } }, done ? icon("check", "icon") : null),
          h("span" + (done ? ".faint" : ".strong"), { style: done ? { textDecoration: "line-through" } : {} }, label),
          done ? null : icon("chevronRight", "icon"))))) : null;

    const body = h("div");
    mount(content, quick, checklist, body);

    async function load() {
      mount(body, spinnerBlock());
      const { report: r } = await api.get("/api/a/report?days=" + days);
      const delta = (cur, prev) => {
        if (!prev) return cur ? h("span.k-delta.up", icon("trendUp"), "new") : h("span.k-delta.faint", "—");
        const p = Math.round(((cur - prev) / prev) * 100);
        return h("span.k-delta." + (p >= 0 ? "up" : "down"), icon(p >= 0 ? "trendUp" : "trendDown"), (p >= 0 ? "+" : "") + p + "% vs previous");
      };
      const prep = !r.avg_prep_seconds ? "—" : r.avg_prep_seconds < 60 ? "< 1 min" : Math.round(r.avg_prep_seconds / 60) + " min";
      const kpi = (ic, label, value, extra) => h("div.card.kpi", h("div.k-label", h("span.ic", icon(ic)), label), h("div.k-value", value), extra || h("span.k-delta.faint", " "));
      const kpis = h("div.kpis",
        kpi("dollar", "Revenue", money(r.revenue), delta(r.revenue, r.prev_revenue)),
        kpi("receipt", "Orders", String(r.orders), delta(r.orders, r.prev_orders)),
        kpi("bag", "Average order", money(r.avg_order), h("span.k-delta.faint", r.items_sold + " items sold")),
        kpi("clock", "Avg. kitchen time", prep, h("span.k-delta.faint", "order → ready")));

      const chartData = days === 1
        ? r.by_hour.map((v, i) => ({ label: String(i).padStart(2, "0"), value: r.by_hour_revenue[i], tip: i + ":00 — " + v + " orders · " + money(r.by_hour_revenue[i]) }))
        : r.by_day.map((d) => ({ label: d.day.slice(8), value: d.revenue, tip: d.day + " — " + money(d.revenue) }));
      const chartCard = h("div.card.card-pad",
        h("div.panel-title", h("h3", days === 1 ? "Sales by hour" : "Sales by day"), h("span.spacer"), h("span.muted.small", money(r.revenue))),
        barChart(chartData));

      const maxQty = Math.max(1, ...r.top_items.map((x) => x.qty));
      const top = h("div.card.card-pad",
        h("div.panel-title", h("h3", "Best sellers")),
        r.top_items.length ? h("div.rank", r.top_items.map((it, i) => h("div.rank-row",
          h("span.pos", String(i + 1)),
          h("div", h("div.strong.ellipsis", it.name), h("div.meter", h("i", { style: { width: (it.qty / maxQty * 100) + "%" } }))),
          h("div", { style: { textAlign: "right" } }, h("div.strong", it.qty + "×"), h("div.tiny.faint", money(it.revenue))))))
          : h("p.muted.small", "No sales in this period yet."));

      const pays = Object.entries(r.payments);
      const side2 = h("div.stack",
        r.unpaid_count ? h("div.alert.warn", icon("alert"), h("div", h("b", money(r.unpaid) + " unpaid"), " across " + r.unpaid_count + " order(s)."),
          h("a.btn.btn-sm", { href: "#/orders?unpaid" }, "Review")) : null,
        h("div.card.card-pad",
          h("div.panel-title", h("h3", "Top tables")),
          r.top_tables.length ? h("div.rank", r.top_tables.map((t, i) => h("div.rank-row",
            h("span.pos", String(i + 1)), h("div.strong", t.table), h("div", { style: { textAlign: "right" } }, h("div.strong", money(t.revenue)), h("div.tiny.faint", t.orders + " orders")))))
            : h("p.muted.small", "No orders yet.")),
        h("div.card.card-pad",
          h("div.panel-title", h("h3", "Payments collected")),
          pays.length ? h("div.rank", pays.map(([m, v]) => h("div.rank-row", h("span.pos", icon(m === "card" ? "card" : "cash", "icon")), h("div.strong", m.charAt(0).toUpperCase() + m.slice(1)), h("div.strong", money(v)))))
            : h("p.muted.small", "Nothing marked as paid yet."),
          r.cancelled ? h("p.tiny.faint", { style: { marginTop: "10px" } }, r.cancelled + " cancelled order(s) not counted.") : null));

      mount(body, kpis, h("div.dash-grid", h("div.stack", chartCard, top), side2));
    }
    await load();
  }

  function barChart(data) {
    const W = 720, H = 220, padL = 44, padB = 24, padT = 10;
    const max = Math.max(1, ...data.map((d) => d.value));
    const niceMax = niceCeil(max);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "chart");
    const mk = (tag, attrs, text) => { const e = document.createElementNS(svgNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    for (let i = 0; i <= 4; i++) {
      const y = padT + (H - padT - padB) * (1 - i / 4);
      svg.append(mk("line", { x1: padL, x2: W, y1: y, y2: y, class: "grid" }));
      svg.append(mk("text", { x: padL - 8, y: y + 4, "text-anchor": "end", class: "axis" }, shortMoney(niceMax * i / 4)));
    }
    const bw = (W - padL) / data.length;
    data.forEach((d, i) => {
      const hgt = (H - padT - padB) * (d.value / niceMax);
      const x = padL + i * bw + bw * 0.18;
      const rect = mk("rect", { x, y: H - padB - Math.max(hgt, 2), width: bw * 0.64, height: Math.max(hgt, 2), rx: Math.min(6, bw * 0.2), class: "bar" + (d.value ? "" : " zero") });
      rect.append(mk("title", {}, d.tip));
      svg.append(rect);
      const every = data.length > 16 ? 3 : 1;
      if (i % every === 0) svg.append(mk("text", { x: x + bw * 0.32, y: H - 6, "text-anchor": "middle", class: "axis" }, d.label));
    });
    return svg;
  }
  function niceCeil(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function shortMoney(minor) {
    const v = minor / Math.pow(10, money.decimals);
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
  }

  // ================================================================ live orders
  function pageLive() {
    let showDone = false;
    const soundBtn = h("button.btn.btn-sm", {
      onclick: () => { Live.sound = !Live.sound; store.set("tt_admin_sound", Live.sound); if (Live.sound) { TT.unlockAudio(); TT.chime(); } paintSound(); },
    });
    const paintSound = () => mount(soundBtn, icon(Live.sound ? "volume" : "volumeX"), Live.sound ? "Sound on" : "Sound off");
    paintSound();
    const doneBtn = h("button.btn.btn-sm", { onclick: () => { showDone = !showDone; doneBtn.classList.toggle("btn-dark", showDone); draw(); } }, icon("check"), "Show served");
    mount(actionsEl, doneBtn, soundBtn, h("a.btn.btn-sm.btn-primary", { href: "/kitchen", target: "_blank" }, icon("chef"), "Kitchen display"));
    subEl.textContent = "Updates instantly — no need to refresh";

    const callsBox = h("div.live-calls");
    const lanes = {};
    const wrap = h("div.lanes");
    for (const [k, label] of [["new", "New"], ["preparing", "Preparing"], ["ready", "Ready to serve"]]) {
      lanes[k] = h("div");
      wrap.append(h("section.lane." + k, h("div.lane-head", h("span.dot"), label, h("span.n", "0")), lanes[k]));
    }
    const doneBox = h("div.card", { style: { marginTop: "14px" }, hidden: true });
    mount(content, callsBox, wrap, doneBox);
    const painted = new Set();

    function card(o) {
      const age = Math.floor((Live.now() - o.created_at) / 60);
      const next = { new: ["preparing", "Accept", "btn-primary"], preparing: ["ready", "Ready", "btn-ok"], ready: ["served", "Served", "btn-dark"] }[o.status];
      const fresh = !painted.has(o.id) && painted.size > 0;
      const el = h("div.ocard" + (fresh ? ".fresh" : ""), { onclick: () => orderDetail(o.id) },
        h("div.ocard-head", h("span.no", "#" + o.number), h("span.tbl", o.table_label || "—"),
          o.customer_name ? h("span.small.muted.ellipsis", o.customer_name) : null,
          h("span.age" + (age >= 20 && o.status !== "ready" ? ".late" : ""), age < 1 ? "now" : age + " min")),
        h("div.ocard-items", o.items.map((l, i) => [i ? ", " : "", h("b", l.qty + "×"), " " + l.name])),
        o.note ? h("div.small", { style: { color: "var(--warn)", fontWeight: 700, marginBottom: "8px" } }, "“" + o.note + "”") : null,
        h("div.ocard-foot",
          h("span.total", money(o.total)),
          o.paid ? badge("Paid", "ok") : null,
          next ? h("button.btn.btn-sm." + next[2], { onclick: (e) => { e.stopPropagation(); setStatus(o, next[0], e.currentTarget); } }, next[1]) : null,
          h("button.btn.btn-sm.btn-ghost.btn-icon", { "aria-label": "More", onclick: (e) => { e.stopPropagation(); orderMenu(o, e.currentTarget); } }, icon("menu"))));
      return el;
    }

    function draw() {
      const byStatus = { new: [], preparing: [], ready: [] };
      Live.orders.forEach((o) => { if (byStatus[o.status]) byStatus[o.status].push(o); });
      for (const k in byStatus) {
        const list = byStatus[k];
        lanes[k].parentElement.querySelector(".n").textContent = list.length;
        mount(lanes[k], list.length ? list.map(card) : h("div.lane-empty", k === "new" ? "Waiting for orders…" : "Nothing here"));
      }
      Live.orders.forEach((o) => painted.add(o.id));
      clear(callsBox);
      for (const c of Live.calls) {
        callsBox.append(h("div.lcall" + (c.kind === "bill" ? ".bill" : ""),
          icon(c.kind === "bill" ? "receipt" : "hand"),
          h("span", c.table_label + " · " + (c.kind === "bill" ? "wants the bill" + (c.payment_hint ? " (" + c.payment_hint + ")" : "") : "needs a waiter")),
          h("small", TT.timeAgo(c.created_at, Live.now())),
          c.kind === "bill" && c.table_id ? h("button.btn.btn-sm", { onclick: () => settleTable(c.table_id, c.table_label, c.payment_hint) }, icon("dollar"), "Settle") : null,
          h("button.btn.btn-sm.btn-dark", { onclick: async () => { try { await api.post("/api/s/calls/" + c.id + "/resolve", {}); } catch (e) { toast(e.message, "error"); } } }, "Done")));
      }
      const done = Live.orders.filter((o) => o.status === "served" || o.status === "cancelled").reverse();
      doneBox.hidden = !showDone;
      if (showDone) {
        mount(doneBox, done.length ? ordersTable(done) : h("p.muted.small", { style: { padding: "16px" } }, "Nothing served in the last 90 minutes."));
      }
    }

    Live.listeners.add(draw);
    const timer = setInterval(draw, 30000);
    if (Live.loaded) draw();
    return () => { Live.listeners.delete(draw); clearInterval(timer); };
  }

  async function setStatus(o, status, btn, reason) {
    const run = async () => {
      try {
        await api.post("/api/s/orders/" + o.id + "/status", { status, reason });
        toast("#" + o.number + " → " + STATUS_LABEL[status], "ok", { duration: 1800 });
      } catch (e) { toast(e.message, "error"); }
    };
    return btn ? withBusy(btn, run) : run();
  }

  async function markPaid(o, method) {
    try {
      await api.post("/api/s/orders/" + o.id + "/pay", { paid: !!method, method });
      toast(method ? "#" + o.number + " marked paid (" + method + ")" : "#" + o.number + " marked unpaid", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  function orderMenu(o, anchor, after) {
    const done = after || (() => {});
    popMenu(anchor, [
      { icon: "eye", label: "Order details", run: () => orderDetail(o.id) },
      o.paid ? { icon: "undo", label: "Mark as unpaid", run: () => markPaid(o, "").then(done) }
        : { icon: "cash", label: "Paid in cash", run: () => markPaid(o, "cash").then(done) },
      o.paid ? null : { icon: "card", label: "Paid by card", run: () => markPaid(o, "card").then(done) },
      "-",
      { icon: "printer", label: "Print kitchen ticket", run: () => window.open("/print/order/" + o.id, "_blank", "width=420,height=640") },
      { icon: "receipt", label: "Print guest bill", run: () => window.open("/print/order/" + o.id + "?kind=bill", "_blank", "width=420,height=640") },
      "-",
      o.status === "cancelled"
        ? { icon: "undo", label: "Restore order", run: () => setStatus(o, "new").then(done) }
        : { icon: "ban", label: "Cancel order", danger: true, run: () => cancelOrder(o, done) },
    ]);
  }

  function cancelOrder(o, done) {
    const reason = h("input.input", { maxlength: 200, placeholder: "e.g. Guest left, item unavailable" });
    const btn = h("button.btn.btn-danger", { onclick: async () => { await setStatus(o, "cancelled", btn, reason.value); m.close(); if (done) done(); } }, "Cancel order");
    const m = modal({
      title: "Cancel order #" + o.number + "?", size: "narrow",
      body: h("div.stack", h("p.muted", "The guest sees the order as cancelled on their phone. You can restore it later."), field("Reason (shown to the guest)", reason)),
      foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Keep order"), btn],
    });
  }

  function settleTable(tableId, label, hint) {
    const orders = Live.orders.filter((o) => o.table_id === tableId && !o.paid && o.status !== "cancelled");
    const total = orders.reduce((a, o) => a + o.total, 0);
    let method = hint || "cash";
    const seg = h("div.seg", ["cash", "card", "other"].map((m) => h("button" + (m === method ? ".on" : ""), {
      onclick: (e) => { method = m; $$("button", seg).forEach((b) => b.classList.toggle("on", b === e.currentTarget)); },
    }, m.charAt(0).toUpperCase() + m.slice(1))));
    const btn = h("button.btn.btn-ok", {
      onclick: () => withBusy(btn, async () => {
        try {
          const res = await api.post("/api/s/tables/" + tableId + "/settle", { method });
          toast(label + " settled · " + res.settled + " order(s)", "ok");
          m.close();
        } catch (e) { toast(e.message, "error"); }
      }),
    }, icon("check"), "Mark all paid");
    const m = modal({
      title: "Settle " + label, size: "narrow",
      body: h("div.stack",
        orders.length ? h("div", orders.map((o) => h("div.oline", h("span.q", "#" + o.number), h("span.n", o.items.map((l) => l.qty + "× " + l.name).join(", ")), h("span.p", money(o.total)))))
          : h("p.muted", "No unpaid orders for this table in the live window."),
        h("div.row", h("b", "Total"), h("span.spacer"), h("b", { style: { fontSize: "20px" } }, money(total))),
        field("Payment method", seg)),
      foot: [h("a.btn.btn-ghost", { href: "/print/table/" + tableId, target: "_blank" }, icon("printer"), "Print bill"), btn],
    });
  }

  // ================================================================ order detail (shared)
  async function orderDetail(id, onChange) {
    const m = modal({ title: "Order", size: "wide", body: spinnerBlock() });
    async function load() {
      let o;
      try { o = (await api.get("/api/s/orders/" + id)).order; }
      catch (e) { mount(m.body, h("p.field-error", e.message)); return; }
      m.el.querySelector(".modal-head h3").textContent = "Order #" + o.number;
      const tl = [["Received", o.created_at], ["Preparing", o.preparing_at], ["Ready", o.ready_at], ["Served", o.served_at]];
      const after = async () => { await load(); if (onChange) onChange(); };
      const next = { new: ["preparing", "Accept"], preparing: ["ready", "Mark ready"], ready: ["served", "Mark served"] }[o.status];
      mount(m.body,
        h("div.odetail-head", statusBadge(o.status), o.paid ? badge("Paid · " + o.payment_method, "ok") : badge("Unpaid", "warn"),
          h("span.muted.small", (o.table_label || "No table") + " · " + TT.fmtDateTime(o.created_at)),
          o.customer_name ? h("span.badge", o.customer_name) : null),
        o.status === "cancelled"
          ? h("div.alert.danger", { style: { marginTop: "14px" } }, icon("ban"), h("div", h("b", "Cancelled"), o.cancel_reason ? " — " + o.cancel_reason : ""))
          : h("div.timeline", tl.map(([l, ts]) => h("div.tl" + (ts ? ".done" : ""), l, h("small", ts ? TT.fmtTime(ts) : "—")))),
        h("div", o.items.map((l) => h("div.oline",
          h("span.q", l.qty + "×"),
          h("span.n", l.name, l.options.length ? h("small", l.options.map((x) => x.choice + (x.price ? " (+" + money(x.price) + ")" : "")).join(", ")) : null,
            l.note ? h("small", { style: { color: "var(--warn)", fontWeight: 700 } }, "“" + l.note + "”") : null),
          h("span.p", money(l.line_total))))),
        o.note ? h("div.alert.warn", { style: { marginTop: "12px" } }, icon("note"), h("div", h("b", "Note: "), o.note)) : null,
        h("div", { style: { marginTop: "12px", marginLeft: "auto", maxWidth: "320px" } },
          h("div.row", h("span.muted", "Subtotal"), h("span.spacer"), h("span.num", money(o.subtotal))),
          o.service ? h("div.row", h("span.muted", "Service"), h("span.spacer"), h("span.num", money(o.service))) : null,
          o.tax ? h("div.row", h("span.muted", REST.tax_inclusive ? "Tax (included)" : "Tax"), h("span.spacer"), h("span.num", money(o.tax))) : null,
          h("div.row", { style: { fontSize: "18px", fontWeight: 800, marginTop: "6px" } }, h("span", "Total"), h("span.spacer"), h("span.num", money(o.total)))));
      const foot = m.el.querySelector(".modal-foot") || m.el.appendChild(h("div.modal-foot"));
      mount(foot,
        h("button.btn.btn-ghost.btn-icon", { "aria-label": "More", onclick: (e) => orderMenu(o, e.currentTarget, after) }, icon("menu")),
        h("span.spacer"),
        o.paid ? null : h("button.btn", { onclick: async () => { await markPaid(o, "cash"); after(); } }, icon("cash"), "Paid cash"),
        o.paid ? null : h("button.btn", { onclick: async () => { await markPaid(o, "card"); after(); } }, icon("card"), "Paid card"),
        next ? h("button.btn.btn-primary", { onclick: async (e) => { await setStatus(o, next[0], e.currentTarget); after(); } }, next[1]) : null);
    }
    await load();
  }

  function ordersTable(list, onRow) {
    return h("div.table-wrap", h("table.dtable",
      h("thead", h("tr", ["#", "Time", "Table", "Items", "Status", "Payment", "Total"].map((c, i) => h("th" + (i === 6 ? ".r" : ""), c)))),
      h("tbody", list.map((o) => h("tr.click", { onclick: () => orderDetail(o.id, onRow) },
        h("td.strong", "#" + o.number),
        h("td.muted.num", TT.fmtDateTime(o.created_at)),
        h("td", o.table_label || "—", o.customer_name ? h("div.tiny.faint", o.customer_name) : null),
        h("td.muted", o.items ? o.items.map((l) => l.qty + "× " + l.name).join(", ").slice(0, 60) : o.item_count + " item(s)"),
        h("td", statusBadge(o.status)),
        h("td", o.paid ? badge(o.payment_method || "paid", "ok") : o.status === "cancelled" ? "—" : badge("Unpaid", "warn")),
        h("td.r.strong.num", money(o.total)))))));
  }

  // ================================================================ order history
  async function pageOrders() {
    const qs = new URLSearchParams(location.hash.split("?")[1] || "");
    const state = { status: qs.has("unpaid") ? "unpaid" : "", days: 7, q: "", page: 1 };
    const statusSeg = h("div.seg", [["", "All"], ["active", "Active"], ["unpaid", "Unpaid"], ["served", "Served"], ["cancelled", "Cancelled"]].map(([v, l]) =>
      h("button" + (v === state.status ? ".on" : ""), { dataset: { v }, onclick: () => { state.status = v; state.page = 1; $$("button", statusSeg).forEach((b) => b.classList.toggle("on", b.dataset.v === v)); load(); } }, l)));
    const range = select("days", [[1, "Today"], [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [0, "All time"]], state.days);
    range.style.width = "auto";
    range.addEventListener("change", () => { state.days = +range.value; state.page = 1; load(); });
    const search = h("input.input", { placeholder: "Order #, table, name…", oninput: TT.debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 250) });
    const exportBtn = isManager ? h("a.btn", { href: "#" }, icon("download"), "Export CSV") : null;
    mount(actionsEl, exportBtn);
    const summary = h("div.muted.small");
    const box = h("div.card");
    mount(content, h("div.toolbar", statusSeg, range, h("div.search-input", icon("search"), search), h("span.spacer"), summary), box);

    async function load() {
      const p = new URLSearchParams({ status: state.status, days: state.days, q: state.q, page: state.page });
      if (exportBtn) exportBtn.href = "/api/a/orders.csv?" + p.toString();
      mount(box, spinnerBlock());
      const res = await api.get("/api/a/orders?" + p.toString());
      summary.textContent = res.total + " order(s) · " + money(res.revenue);
      if (!res.orders.length) return mount(box, emptyState("receipt", "No orders found", "Try another filter or date range."));
      mount(box, ordersTable(res.orders, load),
        res.pages > 1 ? h("div.pager", "Page " + res.page + " of " + res.pages,
          h("button.btn.btn-sm", { disabled: res.page <= 1, onclick: () => { state.page--; load(); } }, icon("chevronLeft")),
          h("button.btn.btn-sm", { disabled: res.page >= res.pages, onclick: () => { state.page++; load(); } }, icon("chevronRight"))) : null);
    }
    await load();
    const refresh = TT.debounce(() => { if (state.page === 1) load(); }, 800);
    Live.listeners.add(refresh);
    return () => Live.listeners.delete(refresh);
  }

  // ================================================================ menu editor
  async function pageMenu() {
    let data = await api.get("/api/a/menu");
    let active = store.get("tt_menu_cat", "all");
    let q = "";
    const catBox = h("div");
    const itemsBox = h("div.stack");
    const search = h("input.input", { placeholder: "Search items…", oninput: TT.debounce((e) => { q = e.target.value.toLowerCase(); drawItems(); }, 150) });
    const restockBtn = h("button.btn", { onclick: restockAll }, icon("refresh"), "Restock all");

    mount(actionsEl,
      h("a.btn", { href: "/r/" + REST.slug, target: "_blank" }, icon("eye"), "Preview"),
      h("button.btn.btn-primary", { onclick: () => editItem(null) }, icon("plus"), "Add item"));
    mount(content, h("div.menu-layout",
      h("div.card.cat-list", catBox,
        h("button.btn.btn-ghost.btn-block", { style: { marginTop: "6px", justifyContent: "flex-start" }, onclick: () => editCategory(null) }, icon("plus"), "Add category")),
      h("div", h("div.toolbar", h("div.search-input", icon("search"), search), h("span.spacer"), restockBtn), itemsBox)));

    async function reload() { data = await api.get("/api/a/menu"); draw(); }
    function draw() { drawCats(); drawItems(); }

    function drawCats() {
      const count = (cid) => data.items.filter((i) => i.category_id === cid).length;
      const list = h("div");
      list.append(h("div.cat-item" + (active === "all" ? ".active" : ""), { onclick: () => { active = "all"; store.set("tt_menu_cat", active); draw(); } },
        h("span.ci", icon("list", "icon")), h("span.cn", "All items"), h("span.cc", String(data.items.length))));
      const sortBox = h("div");
      for (const c of data.categories) {
        sortBox.append(h("div.cat-item" + (active === c.id ? ".active" : "") + (c.visible ? "" : ".hidden-cat"), {
          dataset: { id: c.id },
          onclick: (e) => { if (e.target.closest(".drag")) return; active = c.id; store.set("tt_menu_cat", active); draw(); },
        }, h("span.drag", icon("grip")), h("span.ci", c.icon || "•"), h("span.cn", c.name), h("span.cc", String(count(c.id)))));
      }
      sortable(sortBox, ".cat-item", async (ids) => {
        try {
          await api.post("/api/a/categories/reorder", { ids });
          data.categories.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
          toast("Category order saved", "ok", { duration: 1400 });
        } catch (e) { toast(e.message, "error"); reload(); }
      });
      list.append(sortBox);
      mount(catBox, list);
      if (active !== "all" && !data.categories.find((c) => c.id === active)) active = "all";
    }

    function drawItems() {
      restockBtn.hidden = !data.items.some((i) => !i.available);
      const cats = active === "all" ? data.categories : data.categories.filter((c) => c.id === active);
      if (!data.categories.length) {
        return mount(itemsBox, h("div.card", emptyState("utensils", "Start with a category", "Categories are the sections of your menu — like Starters, Mains or Drinks.",
          h("button.btn.btn-primary", { onclick: () => editCategory(null) }, icon("plus"), "Add category"))));
      }
      clear(itemsBox);
      for (const c of cats) {
        let items = data.items.filter((i) => i.category_id === c.id);
        if (q) items = items.filter((i) => (i.name + " " + i.description).toLowerCase().includes(q));
        if (q && !items.length) continue;
        const rows = h("div");
        items.forEach((it) => rows.append(itemRow(it)));
        if (!q) sortable(rows, ".irow", async (ids) => {
          try {
            await api.post("/api/a/items/reorder", { category_id: c.id, ids });
            toast("Order saved", "ok", { duration: 1400 });
            ids.forEach((id, i) => { const it = data.items.find((x) => String(x.id) === id); if (it) it.sort = i; });
            data.items.sort((a, b) => a.sort - b.sort);
          } catch (e) { toast(e.message, "error"); reload(); }
        });
        itemsBox.append(h("div.card",
          h("div.cat-header",
            h("span", { style: { fontSize: "22px" } }, c.icon || ""),
            h("div", { style: { minWidth: 0 } },
              h("h2", c.name, !c.visible ? h("span.badge", { style: { marginLeft: "8px" } }, "Hidden") : null),
              h("div.small.muted", [c.description, c.available_from ? "Served " + c.available_from + "–" + c.available_to : ""].filter(Boolean).join(" · "))),
            h("span.spacer"),
            h("button.btn.btn-sm", { onclick: () => editCategory(c) }, icon("edit"), "Edit"),
            h("button.btn.btn-sm.btn-primary", { onclick: () => editItem(null, c.id) }, icon("plus"), "Item")),
          items.length ? rows : h("div.lane-empty", "No items yet — add the first one.")));
      }
      if (!itemsBox.childNodes.length) itemsBox.append(h("div.card", emptyState("search", "No items match “" + q + "”", "")));
    }

    function itemRow(it) {
      const promo = it.compare_price > it.price;
      return h("div.irow" + (it.visible ? "" : ".is-hidden"), { dataset: { id: it.id } },
        h("span.drag", icon("grip")),
        h("div.ithumb", it.image ? h("img", { src: "/u/" + it.image, alt: "", loading: "lazy" }) : (it.emoji || it.name.charAt(0))),
        h("div", { style: { minWidth: 0, cursor: "pointer" }, onclick: () => editItem(it) },
          h("div.iname", it.name,
            !it.available ? badge("Sold out", "danger") : null,
            !it.visible ? badge("Hidden") : null,
            it.options.length ? badge(it.options.length + " option group" + (it.options.length > 1 ? "s" : ""), "info") : null,
            it.tags.slice(0, 2).map((t) => badge(TAG_LABEL[t] || t))),
          h("div.idesc", it.description || h("span.faint", "No description")),
          it.sold_30d ? h("div.tiny.faint", it.sold_30d + " sold in 30 days") : null),
        h("div.iprice", money(it.price), promo ? h("div.tiny.faint", { style: { textDecoration: "line-through" } }, money(it.compare_price)) : null),
        h("div.iactions",
          h("span", { title: it.available ? "In stock" : "Sold out" }, switchInput(it.available, async (on, e) => {
            try {
              await api.post("/api/s/items/" + it.id + "/availability", { available: on });
              it.available = on ? 1 : 0;
              toast(it.name + (on ? " is back in stock" : " marked sold out"), on ? "ok" : "info", { duration: 1800 });
              drawItems();
            } catch (err) { e.target.checked = !on; toast(err.message, "error"); }
          }, null, "sm")),
          h("button.btn.btn-ghost.btn-icon.btn-sm", { "aria-label": "More", onclick: (e) => popMenu(e.currentTarget, [
            { icon: "edit", label: "Edit", run: () => editItem(it) },
            { icon: "copy", label: "Duplicate", run: async () => { await api.post("/api/a/items/" + it.id + "/duplicate", {}); toast("Duplicated", "ok"); reload(); } },
            { icon: it.visible ? "eyeOff" : "eye", label: it.visible ? "Hide from menu" : "Show on menu", run: async () => { await api.put("/api/a/items/" + it.id, { visible: !it.visible }); reload(); } },
            "-",
            { icon: "trash", label: "Delete", danger: true, run: async () => {
              if (await confirmDialog({ title: "Delete " + it.name + "?", message: "It disappears from the menu. Past orders keep their history.", ok: "Delete", danger: true })) {
                try { await api.del("/api/a/items/" + it.id); toast("Deleted", "ok"); reload(); } catch (e) { toast(e.message, "error"); }
              }
            } },
          ]) }, icon("menu"))));
    }

    async function restockAll() {
      const n = data.items.filter((i) => !i.available).length;
      if (!await confirmDialog({ title: "Restock all items?", message: "Mark " + n + " sold-out item(s) as available again — useful at the start of a service.", ok: "Restock" })) return;
      const res = await api.post("/api/a/items/restock-all", {});
      toast(res.count + " item(s) back in stock", "ok");
      reload();
    }

    function editCategory(c) {
      const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
        h("div.grid-2", { style: { gridTemplateColumns: "90px 1fr" } },
          field("Icon", h("input.input", { name: "icon", maxlength: 8, value: c ? c.icon : "", placeholder: "🍕", style: { textAlign: "center", fontSize: "20px" } })),
          field("Name", h("input.input", { name: "name", maxlength: 60, value: c ? c.name : "", placeholder: "e.g. Starters", autofocus: true }))),
        field("Description", h("input.input", { name: "description", maxlength: 200, value: c ? c.description : "", placeholder: "Optional — shown under the title" })),
        h("div.grid-2",
          field("Served from", h("input.input", { name: "available_from", type: "time", value: c ? c.available_from : "" })),
          field("Until", h("input.input", { name: "available_to", type: "time", value: c ? c.available_to : "" }))),
        h("p.hint", "Leave both times empty to serve all day. Outside these hours guests can see but not order this category."),
        switchInput(c ? c.visible : true, () => {}, "Visible on the menu"));
      const visibleInput = form.querySelector('input[type="checkbox"]');
      const save = h("button.btn.btn-primary", {
        onclick: () => withBusy(save, async () => {
          const d = Object.fromEntries(new FormData(form));
          d.visible = visibleInput.checked;
          try {
            if (c) await api.put("/api/a/categories/" + c.id, d);
            else { const r = await api.post("/api/a/categories", d); active = r.category.id; store.set("tt_menu_cat", active); }
            m.close();
            toast(c ? "Category saved" : "Category created", "ok");
            reload();
          } catch (e) { handleFormError(form, e); }
        }),
      }, c ? "Save" : "Create category");
      const del = c ? h("button.btn.btn-ghost", { style: { color: "var(--danger)", marginRight: "auto" }, onclick: async () => {
        const n = data.items.filter((i) => i.category_id === c.id).length;
        if (!await confirmDialog({ title: "Delete “" + c.name + "”?", message: n ? "This also deletes its " + n + " item(s). Past orders keep their history." : "This category is empty.", ok: "Delete", danger: true })) return;
        try { await api.del("/api/a/categories/" + c.id + (n ? "?force=1" : "")); m.close(); toast("Category deleted", "ok"); reload(); }
        catch (e) { toast(e.message, "error"); }
      } }, icon("trash"), "Delete") : null;
      const m = modal({ title: c ? "Edit category" : "New category", body: form, foot: [del, h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }

    function editItem(it, catId) {
      if (!data.categories.length) { toast("Create a category first", "info"); return editCategory(null); }
      const draft = it ? JSON.parse(JSON.stringify(it)) : {
        name: "", description: "", price: 0, compare_price: 0, image: "", emoji: "", tags: [], allergens: [], calories: 0, prep_minutes: 0,
        options: [], available: 1, visible: 1, category_id: catId || (active !== "all" ? active : data.categories[0].id),
      };
      const form = h("form", { onsubmit: (e) => e.preventDefault() });
      const catSel = select("category_id", data.categories.map((c) => [c.id, (c.icon ? c.icon + " " : "") + c.name]), draft.category_id);
      const priceGroup = (name, val) => h("div.input-group", h("span.input-addon", money.symbol), h("input.input", { name, inputmode: "decimal", value: minorToInput(val), placeholder: (0).toFixed(money.decimals) }));
      const chipSet = (values, all, labels) => h("div.chips", all.map((v) => h("button.chip" + (values.includes(v) ? ".on" : ""), {
        type: "button", onclick: (e) => { const i = values.indexOf(v); i >= 0 ? values.splice(i, 1) : values.push(v); e.currentTarget.classList.toggle("on"); },
      }, labels ? labels[v] || v : v)));
      const optBox = h("div");

      function drawOptions() {
        clear(optBox);
        draft.options.forEach((g, gi) => {
          const choices = h("div");
          g.choices.forEach((c, ci) => {
            choices.append(h("div.ch-row",
              h("input.input", { value: c.name, placeholder: "Choice (e.g. Large)", maxlength: 60, oninput: (e) => { c.name = e.target.value; } }),
              h("div.input-group", h("span.input-addon", "+" + money.symbol), h("input.input", {
                value: c.price_display != null ? c.price_display : minorToInput(c.price), inputmode: "decimal", placeholder: "0",
                oninput: (e) => { c.price_display = e.target.value; },
              })),
              h("button.btn.btn-ghost.btn-icon.btn-sm", { type: "button", "aria-label": "Remove choice", onclick: () => { g.choices.splice(ci, 1); drawOptions(); } }, icon("x"))));
          });
          const typeSel = select("", [["single", "Pick one"], ["multi", "Pick several"]], g.type);
          typeSel.addEventListener("change", () => { g.type = typeSel.value; drawOptions(); });
          optBox.append(h("div.og-editor",
            h("div.og-row",
              h("input.input", { value: g.name, placeholder: "Group name (e.g. Size, Extras, Sauce)", maxlength: 60, oninput: (e) => { g.name = e.target.value; } }),
              typeSel,
              h("button.btn.btn-ghost.btn-icon.btn-sm", { type: "button", "aria-label": "Remove group", onclick: () => { draft.options.splice(gi, 1); drawOptions(); } }, icon("trash"))),
            choices,
            h("div.og-flags",
              h("button.btn.btn-sm.btn-soft", { type: "button", onclick: () => { g.choices.push({ name: "", price: 0 }); drawOptions(); } }, icon("plus"), "Add choice"),
              switchInput(g.required, (on) => { g.required = on; }, "Required", "sm"),
              g.type === "multi" ? h("label.row.small", "Max", h("input.input", { type: "number", min: 0, max: 30, value: g.max || 0, style: { width: "74px", minHeight: "34px" }, oninput: (e) => { g.max = +e.target.value || 0; } }), h("span.faint", "0 = no limit")) : null)));
        });
        optBox.append(h("button.btn.btn-soft", { type: "button", style: { marginTop: draft.options.length ? "12px" : 0 }, onclick: () => {
          draft.options.push({ name: "", type: "single", required: false, max: 0, choices: [{ name: "", price: 0 }, { name: "", price: 0 }] });
          drawOptions();
        } }, icon("plus"), "Add option group"));
      }
      drawOptions();

      const img = uploader({ value: draft.image, onChange: (v) => { draft.image = v; } });
      const availSw = switchInput(draft.available, (on) => { draft.available = on ? 1 : 0; }, "In stock");
      const visSw = switchInput(draft.visible, (on) => { draft.visible = on ? 1 : 0; }, "Visible on menu");

      mount(form, h("div.editor-grid",
        h("div.stack",
          field("Name", h("input.input", { name: "name", maxlength: 80, value: draft.name, placeholder: "e.g. Margherita Pizza", autofocus: true })),
          field("Description", h("textarea.textarea", { name: "description", maxlength: 400, placeholder: "What makes it delicious? Ingredients, portion, story…" }, draft.description)),
          h("div.grid-2", field("Price", priceGroup("price", draft.price)), field("Category", catSel)),
          h("div.grid-3",
            field("Was price", priceGroup("compare_price", draft.compare_price), "Shows a promo"),
            field("Prep time (min)", h("input.input", { name: "prep_minutes", type: "number", min: 0, max: 240, value: draft.prep_minutes || "" })),
            field("Calories", h("input.input", { name: "calories", type: "number", min: 0, max: 20000, value: draft.calories || "" })))),
        h("div.stack",
          img,
          field("Emoji (used when there's no photo)", h("input.input", { name: "emoji", maxlength: 8, value: draft.emoji, placeholder: "🍕", style: { fontSize: "20px" } })),
          availSw, visSw)),
        h("div.section-label", icon("star", "icon"), "Labels"),
        chipSet(draft.tags, TAGS, TAG_LABEL),
        h("div.section-label", icon("alert", "icon"), "Allergens"),
        chipSet(draft.allergens, ALLERGENS),
        h("div.section-label", icon("list", "icon"), "Options & extras", h("span.faint.small", { style: { fontWeight: 500 } }, "sizes, sauces, add-ons — with optional extra price")),
        optBox);

      const save = h("button.btn.btn-primary", {
        onclick: () => withBusy(save, async () => {
          const f = Object.fromEntries(new FormData(form));
          const payload = {
            name: f.name, description: f.description, price: f.price, compare_price: f.compare_price, category_id: +f.category_id,
            emoji: f.emoji, image: draft.image, tags: draft.tags, allergens: draft.allergens,
            calories: f.calories || 0, prep_minutes: f.prep_minutes || 0, available: !!draft.available, visible: !!draft.visible,
            options: draft.options.map((g) => ({
              id: g.id, name: g.name, type: g.type, required: !!g.required, max: g.max || 0,
              choices: g.choices.filter((c) => c.name.trim()).map((c) => ({ id: c.id, name: c.name, price_display: c.price_display != null ? c.price_display : minorToInput(c.price) || "0" })),
            })).filter((g) => g.name.trim() || g.choices.length),
          };
          try {
            if (it) await api.put("/api/a/items/" + it.id, payload);
            else await api.post("/api/a/items", payload);
            m.close();
            toast(it ? "Item saved" : "Item added to the menu", "ok");
            reload();
          } catch (e) {
            if (e.code === "bad_options") { optBox.scrollIntoView({ behavior: "smooth" }); toast(e.message, "error"); }
            else handleFormError(form, e);
          }
        }),
      }, it ? "Save changes" : "Add item");
      const m = modal({ title: it ? "Edit item" : "New menu item", size: "wide", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }

    draw();
  }

  // ================================================================ tables & QR
  async function pageTables() {
    let res = await api.get("/api/a/tables");
    const selected = new Set();
    let zone = "";
    const grid = h("div.tgrid");
    const zoneBox = h("div.chips");
    const printBtn = h("button.btn", { onclick: () => printDialog() }, icon("printer"), "Print QR codes");
    mount(actionsEl, printBtn,
      h("button.btn", { onclick: () => addTables(true) }, icon("grid"), "Add many"),
      h("button.btn.btn-primary", { onclick: () => addTables(false) }, icon("plus"), "Add table"));

    const urlInfo = () => {
      const src = res.public_url_source;
      if (src === "lan") {
        return h("div.alert.info", { style: { marginBottom: "18px" } }, icon("wifi"),
          h("div", h("b", "QR codes point to your local network: "), h("code", res.public_url),
            h("div.small", { style: { marginTop: "4px" } }, "Guests must join your Wi-Fi to order. To let them order on mobile data, put TableTap online and set its public address in Settings → Public link before printing.")),
          isPlatform ? h("a.btn.btn-sm", { href: "#/settings" }, "Set public link") : null);
      }
      return h("div.alert.info", { style: { marginBottom: "18px" } }, icon("globe"), h("div", h("b", "QR codes open: "), h("code", res.public_url + "/t/…")));
    };
    const infoBox = h("div");
    mount(content, infoBox, h("div.toolbar", zoneBox, h("span.spacer"),
      h("button.btn.btn-sm.btn-ghost", { onclick: () => { const vis = visible(); const all = vis.every((t) => selected.has(t.id)); vis.forEach((t) => all ? selected.delete(t.id) : selected.add(t.id)); draw(); } }, "Select all")), grid);

    const visible = () => res.tables.filter((t) => !zone || t.zone === zone);

    function draw() {
      mount(infoBox, urlInfo());
      const zones = [...new Set(res.tables.map((t) => t.zone).filter(Boolean))];
      mount(zoneBox, zones.length ? [h("button.chip" + (!zone ? ".on" : ""), { onclick: () => { zone = ""; draw(); } }, "All"),
        ...zones.map((z) => h("button.chip" + (zone === z ? ".on" : ""), { onclick: () => { zone = z; draw(); } }, z))] : []);
      printBtn.lastChild.textContent = selected.size ? "Print " + selected.size + " selected" : "Print QR codes";
      if (!res.tables.length) {
        return mount(grid, h("div.card", { style: { gridColumn: "1 / -1" } }, emptyState("qr", "No tables yet", "Each table gets its own QR code, so orders arrive with the right table number.",
          h("button.btn.btn-primary", { onclick: () => addTables(true) }, icon("plus"), "Create tables"))));
      }
      mount(grid, visible().map((t) => h("div.card.tcard" + (t.active ? "" : ".off"),
        h("input.sel", { type: "checkbox", checked: selected.has(t.id), "aria-label": "Select " + t.label, onchange: (e) => { e.target.checked ? selected.add(t.id) : selected.delete(t.id); draw(); } }),
        h("a.qr-box", { href: t.url, target: "_blank", title: "Open this table's menu" }, h("img", { src: "/qr/" + t.id + ".svg?k=" + t.token, alt: "QR code for " + t.label, loading: "lazy" })),
        h("div.t-title", h("b", t.label), t.zone ? badge(t.zone) : null, !t.active ? badge("Off", "warn") : null, h("span.spacer"), t.seats ? h("span.small.faint", t.seats + " seats") : null),
        h("div.t-stats", h("span", t.stats.orders + " orders · 30d"), h("span", money(t.stats.revenue))),
        h("div.t-actions",
          h("a.btn.btn-sm", { href: "/qr/" + t.id + ".png?download=1", title: "Download PNG" }, icon("download"), "PNG"),
          h("button.btn.btn-sm", { onclick: () => printDialog([t.id]) }, icon("printer")),
          h("span.spacer"),
          h("button.btn.btn-sm.btn-ghost.btn-icon", { "aria-label": "More", onclick: (e) => popMenu(e.currentTarget, [
            { icon: "edit", label: "Edit table", run: () => editTable(t) },
            { icon: "copy", label: "Copy link", run: async () => { await TT.copyText(t.url); toast("Link copied", "ok"); } },
            { icon: "external", label: "Open guest menu", href: t.url, target: "_blank" },
            { icon: t.active ? "ban" : "check", label: t.active ? "Stop orders from this table" : "Accept orders again", run: async () => { await api.put("/api/a/tables/" + t.id, { active: !t.active }); reload(); } },
            { icon: "refresh", label: "New QR code (old one stops working)", run: async () => {
              if (await confirmDialog({ title: "Replace the QR code for " + t.label + "?", message: "The printed code stops working immediately. Use this if a code was copied or misused.", ok: "Replace", danger: true })) {
                await api.put("/api/a/tables/" + t.id, { regenerate: true }); toast("New QR code created — reprint it", "ok"); reload();
              }
            } },
            "-",
            { icon: "trash", label: "Delete table", danger: true, run: async () => {
              if (await confirmDialog({ title: "Delete " + t.label + "?", message: "Its QR code stops working. Past orders are kept.", ok: "Delete", danger: true })) {
                await api.del("/api/a/tables/" + t.id); selected.delete(t.id); toast("Table deleted", "ok"); reload();
              }
            } },
          ]) }, icon("menu"))))));
    }

    async function reload() { res = await api.get("/api/a/tables"); draw(); }

    function addTables(bulk) {
      const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
        bulk ? h("div.grid-3",
          field("Name prefix", h("input.input", { name: "prefix", value: "Table", maxlength: 30 })),
          field("From", h("input.input", { name: "from", type: "number", value: res.tables.length + 1, min: 0 })),
          field("To", h("input.input", { name: "to", type: "number", value: res.tables.length + 10, min: 0 })))
          : field("Table name", h("input.input", { name: "label", maxlength: 40, placeholder: "e.g. Table 12, Terrace 3, Bar 1", autofocus: true })),
        h("div.grid-2",
          field("Zone (optional)", h("input.input", { name: "zone", maxlength: 40, placeholder: "e.g. Terrace, Upstairs" })),
          field("Seats (optional)", h("input.input", { name: "seats", type: "number", min: 0, max: 99 }))));
      const save = h("button.btn.btn-primary", {
        onclick: () => withBusy(save, async () => {
          const d = Object.fromEntries(new FormData(form));
          d.bulk = bulk;
          try { const r = await api.post("/api/a/tables", d); m.close(); toast(r.created + " table(s) created", "ok"); reload(); }
          catch (e) { handleFormError(form, e); }
        }),
      }, bulk ? "Create tables" : "Add table");
      const m = modal({ title: bulk ? "Add many tables" : "Add a table", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }

    function editTable(t) {
      const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
        field("Table name", h("input.input", { name: "label", maxlength: 40, value: t.label })),
        h("div.grid-2",
          field("Zone", h("input.input", { name: "zone", maxlength: 40, value: t.zone })),
          field("Seats", h("input.input", { name: "seats", type: "number", min: 0, max: 99, value: t.seats || "" }))));
      const save = h("button.btn.btn-primary", {
        onclick: () => withBusy(save, async () => {
          try { await api.put("/api/a/tables/" + t.id, Object.fromEntries(new FormData(form))); m.close(); toast("Saved", "ok"); reload(); }
          catch (e) { handleFormError(form, e); }
        }),
      }, "Save");
      const m = modal({ title: "Edit " + t.label, size: "narrow", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }

    function printDialog(ids) {
      const list = ids || (selected.size ? [...selected] : visible().filter((t) => t.active).map((t) => t.id));
      if (!list.length) return toast("No tables to print", "info");
      let style = store.get("tt_print_style", "card");
      const styles = [["card", "Table cards", "6 per A4 page — cut & place in holders"], ["tent", "Tent cards", "2 per page — fold in half, stands on the table"], ["sticker", "Stickers", "12 per page — small square labels"]];
      const opts = h("div.stack", { style: { gap: "8px" } }, styles.map(([v, l, d]) => h("label.toggle-row", { style: { cursor: "pointer", border: "1px solid var(--line)", borderRadius: "12px", padding: "12px 14px" } },
        h("input", { type: "radio", name: "style", value: v, checked: v === style, onchange: () => { style = v; } }),
        h("span.tr-text", h("b", l), h("span", d)))));
      const heading = h("input.input", { maxlength: 60, placeholder: "Scan to see the menu & order", value: store.get("tt_print_heading", "") });
      const go = h("button.btn.btn-primary", { onclick: () => {
        store.set("tt_print_style", style);
        store.set("tt_print_heading", heading.value);
        window.open("/print/qr?" + new URLSearchParams({ ids: list.join(","), style, heading: heading.value }), "_blank");
        m.close();
      } }, icon("printer"), "Open print view");
      const m = modal({
        title: "Print " + list.length + " QR code" + (list.length > 1 ? "s" : ""),
        body: h("div.stack", opts, field("Headline on each card", heading, "Leave empty for the default text in your menu language.")),
        foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), go],
      });
    }

    draw();
  }

  // ================================================================ staff
  async function pageStaff() {
    mount(actionsEl, h("button.btn.btn-primary", { onclick: () => editStaff(null) }, icon("plus"), "Add staff"));
    const box = h("div.card");
    mount(content,
      h("div.grid-3", { style: { marginBottom: "18px" } }, Object.entries(ROLE_INFO).map(([k, [l, d]]) =>
        h("div.card.card-pad", h("div.row", icon(k === "manager" ? "shield" : k === "waiter" ? "hand" : "chef"), h("b", l)), h("p.small.muted", { style: { marginTop: "6px" } }, d)))),
      box);

    async function load() {
      const res = await api.get("/api/a/staff");
      if (!res.staff.length) return mount(box, emptyState("users", "No staff accounts yet", "Give each person their own login — the kitchen tablet can use a Kitchen account.",
        h("button.btn.btn-primary", { onclick: () => editStaff(null) }, icon("plus"), "Add staff")));
      mount(box, h("div.table-wrap", h("table.dtable",
        h("thead", h("tr", ["Name", "Email", "Role", "Status", "Last sign-in", ""].map((c) => h("th", c)))),
        h("tbody", res.staff.map((u) => h("tr",
          h("td", h("div.row", h("span.avatar", { style: { width: "30px", height: "30px", fontSize: "12px" } }, initials(u.name || u.email)), h("b", u.name || "—"))),
          h("td.muted", u.email),
          h("td", badge(ROLE_INFO[u.role] ? ROLE_INFO[u.role][0] : u.role, u.role === "manager" ? "accent" : "")),
          h("td", u.active ? badge("Active", "ok") : badge("Disabled", "warn")),
          h("td.muted.small", u.last_login ? TT.timeAgo(u.last_login) : "Never"),
          h("td.r", h("button.btn.btn-sm", { onclick: () => editStaff(u) }, icon("edit"), "Edit"))))))));
    }

    function editStaff(u) {
      const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
        field("Name", h("input.input", { name: "name", maxlength: 80, value: u ? u.name : "", autofocus: true })),
        u ? null : field("Email (used to sign in)", h("input.input", { name: "email", type: "email", maxlength: 120 })),
        field("Role", select("role", Object.entries(ROLE_INFO).map(([k, [l, d]]) => [k, l + " — " + d]), u ? u.role : "waiter")),
        field(u ? "New password (leave empty to keep)" : "Password",
          h("div.input-group", h("input.input", { name: "password", type: "text", autocomplete: "new-password", minlength: 8 }),
            h("button.btn", { type: "button", onclick: (e) => { const p = genPassword(); form.querySelector('[name="password"]').value = p; } }, "Generate")),
          "At least 8 characters. Share it privately with the person."),
        u ? switchInput(u.active, () => {}, "Account active") : null);
      const save = h("button.btn.btn-primary", {
        onclick: () => withBusy(save, async () => {
          const d = Object.fromEntries(new FormData(form));
          if (u) { d.active = form.querySelector('input[type="checkbox"]').checked; if (!d.password) delete d.password; }
          try {
            if (u) await api.put("/api/a/staff/" + u.id, d); else await api.post("/api/a/staff", d);
            m.close(); toast(u ? "Saved" : "Account created", "ok"); load();
          } catch (e) { handleFormError(form, e); }
        }),
      }, u ? "Save" : "Create account");
      const del = u && u.id !== USER.id ? h("button.btn.btn-ghost", { style: { color: "var(--danger)", marginRight: "auto" }, onclick: async () => {
        if (!await confirmDialog({ title: "Delete " + (u.name || u.email) + "?", message: "They can no longer sign in.", ok: "Delete", danger: true })) return;
        try { await api.del("/api/a/staff/" + u.id); m.close(); toast("Deleted", "ok"); load(); } catch (e) { toast(e.message, "error"); }
      } }, icon("trash"), "Delete") : null;
      const m = modal({ title: u ? "Edit " + (u.name || u.email) : "Add staff member", body: form, foot: [del, h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }
    await load();
  }

  function genPassword() {
    const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => a[n % a.length]).join("");
  }

  // ================================================================ settings
  async function pageSettings() {
    const res = await api.get("/api/a/settings");
    const r = res.restaurant;
    const dirty = {};
    const saveBar = h("div.save-bar", { hidden: true },
      h("span", { style: { flex: 1, fontWeight: 700 } }, "You have unsaved changes"),
      h("button.btn.btn-ghost", { onclick: () => route() }, "Discard"),
      h("button.btn.btn-primary", { onclick: (e) => save(e.currentTarget) }, "Save changes"));
    const mark = (k, v) => { dirty[k] = v; saveBar.hidden = false; };
    const inp = (k, attrs = {}) => h("input.input", Object.assign({ value: r[k] == null ? "" : r[k], oninput: (e) => mark(k, e.target.value) }, attrs));
    const toggleRow = (k, title, text) => h("div.toggle-row", h("div.tr-text", h("b", title), h("span", text)), switchInput(r[k], (on) => mark(k, on)));

    const swatches = ["#e4572e", "#d62d52", "#c2410c", "#b45309", "#15803d", "#0f766e", "#0369a1", "#4338ca", "#7e22ce", "#1c1b19"];
    let accent = r.accent;
    const colorIn = h("input.color-input", { type: "color", value: accent, oninput: (e) => pickColor(e.target.value) });
    const swBox = h("div.swatches");
    function pickColor(c) {
      accent = c;
      colorIn.value = c;
      document.documentElement.style.setProperty("--accent", c);
      mount(swBox, swatches.map((s) => h("button.swatch" + (s === accent ? ".on" : ""), { type: "button", style: { background: s }, "aria-label": s, onclick: () => pickColor(s) })), colorIn);
      if (c !== r.accent) mark("accent", c);
    }
    pickColor(accent);

    const cur = CURRENCIES.find((c) => c.code === r.currency);
    const curSel = select("currency", CURRENCIES.map((c) => [c.code, c.code + " — " + c.name]).concat(cur ? [] : [[r.currency, r.currency]]), r.currency);
    curSel.addEventListener("change", () => {
      const c = CURRENCIES.find((x) => x.code === curSel.value);
      mark("currency", curSel.value);
      if (c) {
        symIn.value = c.symbol; mark("currency_symbol", c.symbol);
        sufSel.value = c.suffix ? "1" : "0"; mark("currency_suffix", c.suffix);
        if (c.decimals !== r.decimals) { decSel.value = String(c.decimals); mark("decimals", c.decimals); }
      }
    });
    const symIn = inp("currency_symbol", { maxlength: 6 });
    const sufSel = select("currency_suffix", [["0", "Before: $12.00"], ["1", "After: 12.00 DH"]], r.currency_suffix ? "1" : "0");
    sufSel.addEventListener("change", () => mark("currency_suffix", sufSel.value === "1"));
    const decSel = select("decimals", [["0", "0 (12)"], ["2", "2 (12.50)"], ["3", "3 (12.500)"]], r.decimals);
    decSel.addEventListener("change", () => mark("decimals", +decSel.value));
    const langSel = select("language", [["en", "English"], ["fr", "Français"], ["es", "Español"], ["ar", "العربية (RTL)"]], r.language);
    langSel.addEventListener("change", () => mark("language", langSel.value));
    const taxIncl = select("tax_inclusive", [["1", "Included in menu prices"], ["0", "Added on top at checkout"]], r.tax_inclusive ? "1" : "0");
    taxIncl.addEventListener("change", () => mark("tax_inclusive", taxIncl.value === "1"));

    const logo = uploader({ value: r.logo, kind: "logo", cls: "logo", label: "Logo", onChange: (v) => mark("logo", v) });
    const cover = uploader({ value: r.cover, kind: "cover", cls: "wide", label: "Cover photo", onChange: (v) => mark("cover", v) });
    const tzGuess = Intl.DateTimeFormat().resolvedOptions().timeZone || "";

    const sections = [
      ["profile", "Restaurant", h("div.set-card.card", { id: "s-profile" },
        h("h3", "Restaurant profile"), h("p.muted", "What guests see at the top of your menu."),
        h("div.stack",
          h("div.grid-2", field("Name", inp("name", { maxlength: 80 })), field("Tagline", inp("tagline", { maxlength: 140, placeholder: "e.g. Wood-fired pizza since 1998" }))),
          h("div.grid-2", field("Phone", inp("phone", { maxlength: 40 })), field("Address", inp("address", { maxlength: 200 }))),
          h("div.grid-2", field("Guest Wi-Fi name", inp("wifi_name", { maxlength: 60 })), field("Wi-Fi password", inp("wifi_password", { maxlength: 60 }), "Guests can copy it with one tap.")),
          field("Guest menu link", h("div.url-box", h("span", location.origin + "/r/" + r.slug),
            h("a.btn.btn-sm", { href: "/r/" + r.slug, target: "_blank" }, icon("external"))), "Browse-only link for your website, Instagram or Google profile. Ordering needs a table QR code.")))],
      ["branding", "Branding", h("div.set-card.card", { id: "s-branding" },
        h("h3", "Branding"), h("p.muted", "Make the menu look like your restaurant."),
        h("div.stack",
          h("div", { style: { display: "grid", gridTemplateColumns: "140px 1fr", gap: "16px" } }, field("Logo", logo), field("Cover photo", cover)),
          field("Brand color", swBox, "Used for buttons, highlights and printed QR cards.")))],
      ["ordering", "Ordering", h("div.set-card.card", { id: "s-ordering" },
        h("h3", "Ordering"), h("p.muted", "How orders flow from the table to the kitchen."),
        toggleRow("ordering_enabled", "Accept orders", "Turn off to make the menu browse-only (e.g. when closed or fully booked)."),
        field("Message when ordering is off", inp("closed_message", { maxlength: 200, placeholder: "e.g. The kitchen opens at 12:00 — see you soon!" })),
        toggleRow("auto_accept", "Send orders straight to “Preparing”", "Skip the Accept step. Good when the kitchen screen is the only screen."),
        toggleRow("require_name", "Ask guests for their name", "Useful for shared tables and counters."))],
      ["money", "Prices & tax", h("div.set-card.card", { id: "s-money" },
        h("h3", "Prices & tax"), h("p.muted", "Currency, tax and service charge."),
        h("div.stack",
          h("div.grid-2", field("Currency", curSel), field("Symbol", symIn)),
          h("div.grid-2", field("Symbol position", sufSel), field("Decimals", decSel, "Can't change once items have prices.")),
          h("div.grid-2",
            field("Tax rate (%)", h("input.input", { value: pct(r.tax_rate), inputmode: "decimal", oninput: (e) => mark("tax_rate", e.target.value) })),
            field("Tax", taxIncl)),
          field("Service charge (%)", h("input.input", { value: pct(r.service_rate), inputmode: "decimal", oninput: (e) => mark("service_rate", e.target.value) }), "Added to every order. 0 to disable.")))],
      ["locale", "Language & time", h("div.set-card.card", { id: "s-locale" },
        h("h3", "Language & time"), h("p.muted", "Guests can still switch language on their phone."),
        h("div.grid-2",
          field("Default guest language", langSel),
          field("Time zone", inp("timezone", { placeholder: tzGuess || "Europe/Paris", list: "tzlist" }), "Used for daily order numbers, reports and serving hours. Empty = this computer's zone."),
          h("datalist#tzlist", tzGuess ? h("option", { value: tzGuess }) : null)))],
      isPlatform ? ["public", "Public link", h("div.set-card.card", { id: "s-public" },
        h("h3", "Public link for QR codes"), h("p.muted", "The web address printed inside every table QR code."),
        h("div.stack",
          h("div.alert.info", icon("info"), h("div",
            h("div", h("b", "Now: "), h("code", res.public_url), " (" + ({ lan: "local Wi-Fi only", custom: "custom", env: "set by server", request: "this address" }[res.public_url_source]) + ")"),
            h("div.small", { style: { marginTop: "6px" } }, "For guests on 4G/5G, host TableTap on a server or expose it with a permanent tunnel (e.g. Cloudflare Tunnel) and enter that https:// address here. Print QR codes after setting it."))),
          field("Public URL", h("input.input", { placeholder: "https://menu.yourdomain.com", oninput: (e) => mark("public_url", e.target.value), value: res.public_url_source === "custom" ? res.public_url : "" }), "Leave empty to use the local network address.")))] : null,
      ["activity", "Activity", h("div.set-card.card", { id: "s-activity" },
        h("div.row", h("h3", "Activity log"), h("span.spacer"), h("button.btn.btn-sm", { onclick: (e) => loadActivity(e.currentTarget) }, "Load")),
        h("p.muted", "Who changed what — logins, menu edits, cancellations, payments."),
        h("div#activity"))],
    ].filter(Boolean);

    mount(content, h("div.settings-layout",
      h("nav.settings-nav", sections.map(([id, label]) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); $("#s-" + id).scrollIntoView({ behavior: "smooth" }); } }, label))),
      h("div", sections.map((s) => s[2]), saveBar)));

    async function loadActivity(btn) {
      await withBusy(btn, async () => {
        const a = await api.get("/api/a/activity");
        mount($("#activity"), a.activity.length ? h("div.table-wrap", h("table.dtable", h("tbody", a.activity.map((x) => h("tr",
          h("td.small.muted.num", TT.fmtDateTime(x.created_at)), h("td.small", x.user_email), h("td.small.strong", x.action.replace(/_/g, " ")), h("td.small.muted", x.detail))))))
          : h("p.muted.small", "Nothing yet."));
      });
    }

    async function save(btn) {
      await withBusy(btn, async () => {
        try {
          const out = await api.put("/api/a/settings", dirty);
          REST = out.restaurant;
          money = TT.moneyFormatter(REST);
          Object.keys(dirty).forEach((k) => delete dirty[k]);
          saveBar.hidden = true;
          toast("Settings saved", "ok");
          buildSide();
        } catch (e) {
          const el = e.field && $('[name="' + e.field + '"]', content);
          toast(e.message, "error");
          if (el) el.focus();
        }
      });
    }
    const beforeUnload = (e) => { if (!saveBar.hidden) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }

  // ================================================================ platform
  async function pagePlatform() {
    mount(actionsEl,
      h("a.btn", { href: "/api/platform/backup/latest" }, icon("database"), "Download backup"),
      h("button.btn.btn-primary", { onclick: createRestaurant }, icon("plus"), "New restaurant"));
    subEl.textContent = "Everything you sell: subscriptions, activity and access";
    const box = h("div");
    mount(content, box);

    async function load() {
      const res = await api.get("/api/platform/restaurants");
      const list = res.restaurants;
      const active = list.filter((r) => r.subscription_ok).length;
      const soon = list.filter((r) => r.paid_until && r.paid_until > Date.now() / 1000 && r.paid_until - Date.now() / 1000 < 7 * 86400).length;
      const kpi = (ic, l, v, extra) => h("div.card.kpi", h("div.k-label", h("span.ic", icon(ic)), l), h("div.k-value", v), extra || null);
      mount(box,
        h("div.kpis", { style: { marginBottom: "18px" } },
          kpi("store", "Restaurants", String(list.length)),
          kpi("check", "Active", String(active)),
          kpi("alert", "Inactive / expired", String(list.length - active)),
          kpi("calendar", "Expiring in 7 days", String(soon))),
        list.length ? h("div.card", h("div.table-wrap", h("table.dtable",
          h("thead", h("tr", ["Restaurant", "Manager", "Plan", "Subscription", "Orders · 30d", "Last order", ""].map((c) => h("th", c)))),
          h("tbody", list.map((r) => {
            const fm = TT.moneyFormatter(r);
            const exp = r.paid_until ? new Date(r.paid_until * 1000).toLocaleDateString() : "No expiry";
            return h("tr.platform-row",
              h("td", h("div.row", h("span.rs-logo", r.logo ? h("img", { src: "/u/" + r.logo, alt: "", style: { width: "100%", height: "100%", objectFit: "cover", borderRadius: "10px" } }) : initials(r.name)),
                h("div", h("b", r.name, r.id === res.current ? badge("current", "accent") : null), h("div.tiny.faint", "/" + r.slug + " · " + r.tables_count + " tables · " + r.items_count + " items")))),
              h("td.small.muted", r.manager_email || "—"),
              h("td", badge(r.plan || "standard")),
              h("td", r.subscription_ok ? badge("Active", "ok") : badge(r.status === "suspended" ? "Suspended" : "Expired", "danger"), h("div.tiny.faint", exp)),
              h("td.num", h("b", String(r.orders_30d)), h("div.tiny.faint", fm(r.revenue_30d))),
              h("td.small.muted", r.last_order ? TT.timeAgo(r.last_order) : "Never"),
              h("td.r", h("div.row", { style: { justifyContent: "flex-end" } },
                h("button.btn.btn-sm", { onclick: async () => { await api.post("/api/platform/switch", { id: r.id }); location.hash = "#/dashboard"; location.reload(); } }, "Open"),
                h("button.btn.btn-sm.btn-ghost.btn-icon", { "aria-label": "More", onclick: (e) => popMenu(e.currentTarget, [
                  { icon: "calendar", label: "Extend 30 days", run: () => upd(r, { extend_days: 30 }, "Extended by 30 days") },
                  { icon: "calendar", label: "Extend 1 year", run: () => upd(r, { extend_days: 365 }, "Extended by 1 year") },
                  { icon: "edit", label: "Plan & expiry…", run: () => editSub(r) },
                  r.status === "active" ? { icon: "ban", label: "Suspend", run: () => upd(r, { status: "suspended" }, "Suspended") }
                    : { icon: "check", label: "Activate", run: () => upd(r, { status: "active" }, "Activated") },
                  { icon: "external", label: "Open guest menu", href: "/r/" + r.slug, target: "_blank" },
                  "-",
                  { icon: "trash", label: "Delete restaurant…", danger: true, run: () => deleteRestaurant(r) },
                ]) }, icon("menu")))));
          }))))) : h("div.card", emptyState("store", "No restaurants yet", "Create your first client restaurant.", h("button.btn.btn-primary", { onclick: createRestaurant }, "New restaurant"))));
    }

    async function upd(r, patch, msg) {
      try { await api.put("/api/platform/restaurants/" + r.id, patch); toast(r.name + ": " + msg, "ok"); load(); }
      catch (e) { toast(e.message, "error"); }
    }

    function editSub(r) {
      const d = r.paid_until ? new Date(r.paid_until * 1000).toISOString().slice(0, 10) : "";
      const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
        field("Plan name", h("input.input", { name: "plan", value: r.plan, maxlength: 30 })),
        field("Paid until", h("input.input", { name: "paid_until", type: "date", value: d }), "Empty = never expires. After this date guests see “menu unavailable”."));
      const save = h("button.btn.btn-primary", { onclick: () => withBusy(save, async () => {
        try { await api.put("/api/platform/restaurants/" + r.id, Object.fromEntries(new FormData(form))); m.close(); toast("Saved", "ok"); load(); }
        catch (e) { handleFormError(form, e); }
      }) }, "Save");
      const m = modal({ title: r.name + " — subscription", size: "narrow", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
    }

    function deleteRestaurant(r) {
      const confirmIn = h("input.input", { placeholder: r.name });
      const btn = h("button.btn.btn-danger", { onclick: () => withBusy(btn, async () => {
        try { await api.del("/api/platform/restaurants/" + r.id, { confirm: confirmIn.value }); m.close(); toast("Deleted " + r.name, "ok"); location.reload(); }
        catch (e) { toast(e.message, "error"); }
      }) }, "Delete forever");
      const m = modal({ title: "Delete " + r.name + "?", size: "narrow",
        body: h("div.stack", h("div.alert.danger", icon("alert"), h("div", "This permanently deletes the menu, tables, staff accounts and ", h("b", "all order history"), ". Download a backup first.")),
          field("Type the restaurant name to confirm", confirmIn)),
        foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), btn] });
    }

    window.__ttReloadPlatform = load;
    await load();
    return () => { delete window.__ttReloadPlatform; };
  }

  function createRestaurant() {
    const form = h("form.stack", { onsubmit: (e) => e.preventDefault() },
      field("Restaurant name", h("input.input", { name: "name", maxlength: 80, autofocus: true })),
      h("div.grid-2",
        field("Currency", select("currency", CURRENCIES.map((c) => [c.code, c.code + " — " + c.name]), "USD")),
        field("Guest language", select("language", [["en", "English"], ["fr", "Français"], ["es", "Español"], ["ar", "العربية"]], "en"))),
      h("div.grid-2",
        field("Plan", h("input.input", { name: "plan", value: "standard", maxlength: 30 })),
        field("Paid until", h("input.input", { name: "paid_until", type: "date", value: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) }))),
      h("div.section-label", icon("users", "icon"), "Manager login (optional)"),
      h("div.grid-2",
        field("Manager name", h("input.input", { name: "manager_name", maxlength: 80 })),
        field("Manager email", h("input.input", { name: "manager_email", type: "email", maxlength: 120 }))),
      field("Manager password", h("div.input-group", h("input.input", { name: "manager_password", type: "text", minlength: 8 }),
        h("button.btn", { type: "button", onclick: () => { form.querySelector('[name="manager_password"]').value = genPassword(); } }, "Generate"))),
      switchInput(true, () => {}, "Start with the demo menu & tables"));
    const save = h("button.btn.btn-primary", { onclick: () => withBusy(save, async () => {
      const d = Object.fromEntries(new FormData(form));
      d.demo = form.querySelector('input[type="checkbox"]').checked;
      try {
        await api.post("/api/platform/restaurants", d);
        m.close();
        toast("Restaurant created", "ok");
        if (!REST) location.reload();
        else if (window.__ttReloadPlatform) window.__ttReloadPlatform();
      } catch (e) { handleFormError(form, e); }
    }) }, "Create restaurant");
    const m = modal({ title: "New restaurant", body: form, foot: [h("button.btn.btn-ghost", { onclick: () => m.close() }, "Cancel"), save] });
  }

  // ================================================================ boot
  renderShell();
  window.addEventListener("hashchange", route);
  route();
  liveLoop();
})();
