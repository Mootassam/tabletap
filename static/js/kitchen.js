/* TableTap kitchen display (KDS): live tickets via long-polling, timers, chimes, 86 board. */
(function () {
  "use strict";
  const { h, icon, api, toast, store, readBoot, mount, clear, $, $$ } = TT;
  const BOOT = readBoot();
  TT.setCsrf(BOOT.csrf);
  const R = BOOT.restaurant;
  const USER = BOOT.user;
  const canServe = USER.role !== "kitchen";

  let rev = -1;
  let orders = [];
  let calls = [];
  let clockSkew = 0;           // server_time - local time (seconds)
  let seen = new Set(store.get("tt_kds_seen", []));
  let firstLoad = true;
  let sound = store.get("tt_kds_sound", true);
  let showCalls = store.get("tt_kds_calls", true);
  let mobileCol = "new";
  const doneLines = store.get("tt_kds_done", {});    // orderId -> [lineIds]
  const WARN_MIN = store.get("tt_kds_warn", 10);
  const LATE_MIN = store.get("tt_kds_late", 20);

  const now = () => Date.now() / 1000 + clockSkew;

  // ------------------------------------------------------------ layout
  const app = $("#app");
  const counts = { new: h("b", "0"), preparing: h("b", "0"), ready: h("b", "0") };
  const clock = h("span.k-clock");
  const conn = h("span.k-conn", { title: "Live connection" });
  const soundBtn = h("button.k-btn", { onclick: toggleSound });
  const banner = h("div.k-banner", { hidden: true, onclick: () => { TT.unlockAudio(); updateSoundUi(); } },
    "🔔 Tap here once to enable sound alerts for new orders");
  const callsBar = h("div.k-calls", { hidden: true });
  const cols = {};
  const lists = {};
  for (const [key, label] of [["new", "New"], ["preparing", "Preparing"], ["ready", "Ready"]]) {
    lists[key] = h("div.k-list");
    cols[key] = h("section.k-col." + key + (key === mobileCol ? ".show" : ""),
      h("div.k-col-head", h("span.dot"), label, h("span.n", "0")), lists[key]);
  }
  const tabs = h("div.k-tabs", ["new", "preparing", "ready"].map((k) =>
    h("button" + (k === mobileCol ? ".on" : ""), {
      dataset: { col: k },
      onclick: () => {
        mobileCol = k;
        $$(".k-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.col === k));
        Object.entries(cols).forEach(([ck, el]) => el.classList.toggle("show", ck === k));
      },
    }, { new: "New", preparing: "Preparing", ready: "Ready" }[k])));

  const top = h("header.k-top",
    h("div.k-brand", h("span.k-logo", icon("chef")), h("span.nm", R.name)),
    h("div.k-counts",
      h("span.k-count.new", "New ", counts.new),
      h("span.k-count", "Cooking ", counts.preparing),
      h("span.k-count.ready", "Ready ", counts.ready)),
    h("span.spacer"),
    conn, clock,
    h("button.k-btn", { title: "Sold-out items", onclick: open86 }, icon("ban"), h("span", "86")),
    h("button.k-btn", { title: "Recently completed", onclick: openRecall }, icon("undo")),
    soundBtn,
    h("button.k-btn", { title: "Waiter calls", onclick: () => { showCalls = !showCalls; store.set("tt_kds_calls", showCalls); renderCalls(); } }, icon("bell")),
    h("button.k-btn", { title: "Full screen", onclick: fullscreen }, icon("maximize")),
    USER.role !== "kitchen"
      ? h("a.k-btn", { href: "/admin", title: "Back to admin" }, icon("home"))
      : h("a.k-btn", { href: "/logout", title: "Sign out" }, icon("logout")));

  mount(app, top, banner, callsBar, tabs, h("main.k-board", cols.new, cols.preparing, cols.ready));
  document.documentElement.style.setProperty("--accent", R.accent || "#e4572e");

  // ------------------------------------------------------------ sound
  function updateSoundUi() {
    mount(soundBtn, icon(sound ? "volume" : "volumeX"));
    soundBtn.classList.toggle("on", sound && TT.audioReady());
    soundBtn.classList.toggle("warn", sound && !TT.audioReady());
    banner.hidden = !sound || TT.audioReady();
  }
  function toggleSound() {
    sound = !sound;
    store.set("tt_kds_sound", sound);
    if (sound) { TT.unlockAudio(); TT.chime("order"); }
    updateSoundUi();
  }
  document.addEventListener("pointerdown", () => { if (sound && !TT.audioReady()) { TT.unlockAudio(); setTimeout(updateSoundUi, 50); } });
  updateSoundUi();

  // Nag every 45 s while tickets sit in "New".
  setInterval(() => {
    if (sound && orders.some((o) => o.status === "new" && now() - o.created_at > 40)) TT.chime("order");
  }, 45000);

  // ------------------------------------------------------------ render
  function ageClass(o) {
    const m = (now() - o.created_at) / 60;
    if (o.status === "ready") return "age-ok";
    return m >= LATE_MIN ? "age-late" : m >= WARN_MIN ? "age-warn" : "age-ok";
  }

  function ticket(o, fresh) {
    const done = new Set(doneLines[o.id] || []);
    const lines = o.items.map((l) => h("div.t-line" + (done.has(l.id) ? ".done" : ""), {
      onclick: (e) => {
        const set = new Set(doneLines[o.id] || []);
        set.has(l.id) ? set.delete(l.id) : set.add(l.id);
        doneLines[o.id] = [...set];
        store.set("tt_kds_done", doneLines);
        e.currentTarget.classList.toggle("done");
      },
    },
      h("span.t-qty", String(l.qty)),
      h("div",
        h("div.t-iname", l.name),
        l.options.length ? h("div.t-opts", groupOpts(l.options)) : null,
        l.note ? h("span.t-inote", "⚠ " + l.note) : null)));

    let go;
    if (o.status === "new") go = h("button.t-go.start", { onclick: (e) => move(o, "preparing", e.currentTarget) }, icon("chef"), "START");
    else if (o.status === "preparing") go = h("button.t-go.ready", { onclick: (e) => move(o, "ready", e.currentTarget) }, icon("check"), "READY");
    else if (canServe) go = h("button.t-go.served", { onclick: (e) => move(o, "served", e.currentTarget) }, icon("utensils"), "SERVED");
    else go = h("button.t-go.served", { disabled: true }, "WAITING FOR PICKUP");

    const back = o.status !== "new"
      ? h("button.t-side", { title: "Move back", onclick: (e) => move(o, o.status === "ready" ? "preparing" : "new", e.currentTarget) }, icon("undo"))
      : null;

    return h("article.ticket." + ageClass(o) + (fresh ? ".fresh" : ""), { dataset: { id: o.id } },
      h("div.t-head",
        h("span.t-num", "#" + o.number),
        h("span.t-table", o.table_label || "—"),
        o.paid ? h("span.t-paid", "PAID") : null,
        h("span.t-time", icon("clock"), h("span.el", { dataset: { ts: o.created_at } }, TT.elapsed(o.created_at, now())))),
      o.customer_name ? h("div.t-name", o.customer_name) : null,
      h("div.t-items", lines),
      o.note ? h("div.t-note", icon("note"), h("span", o.note)) : null,
      h("div.t-foot", back,
        h("button.t-side", { title: "Print ticket", onclick: () => window.open("/print/order/" + o.id, "_blank", "width=420,height=640") }, icon("printer")),
        go));
  }

  function groupOpts(opts) {
    const by = {};
    for (const o of opts) (by[o.group] = by[o.group] || []).push(o.choice);
    return Object.entries(by).map(([g, cs], i) => [i ? " · " : "", h("b", cs.join(", "))]);
  }

  function render() {
    const active = orders.filter((o) => ["new", "preparing", "ready"].includes(o.status));
    const groups = { new: [], preparing: [], ready: [] };
    active.forEach((o) => groups[o.status].push(o));
    for (const k of Object.keys(groups)) {
      const list = groups[k];
      counts[k].textContent = list.length;
      cols[k].querySelector(".n").textContent = list.length;
      const tabBtn = $('.k-tabs button[data-col="' + k + '"]');
      if (tabBtn) tabBtn.textContent = { new: "New", preparing: "Preparing", ready: "Ready" }[k] + (list.length ? " · " + list.length : "");
      const scroll = lists[k].scrollTop;
      if (!list.length) mount(lists[k], h("div.k-empty", k === "new" ? "No new orders" : k === "preparing" ? "Nothing cooking" : "Nothing waiting"));
      else mount(lists[k], list.map((o) => {
        const fresh = !seen.has(o.id) && !firstLoad;
        return ticket(o, fresh);
      }));
      lists[k].scrollTop = scroll;
    }
    const newIds = active.filter((o) => !seen.has(o.id));
    if (newIds.length && !firstLoad && sound) TT.chime("order");
    active.forEach((o) => seen.add(o.id));
    if (seen.size > 500) seen = new Set([...seen].slice(-300));
    store.set("tt_kds_seen", [...seen]);
    document.title = (groups.new.length ? "(" + groups.new.length + ") " : "") + "Kitchen · TableTap";
    renderCalls();
    firstLoad = false;
  }

  let knownCalls = new Set();
  function renderCalls() {
    clear(callsBar);
    callsBar.hidden = !showCalls || !calls.length;
    if (callsBar.hidden) return;
    let fresh = false;
    for (const c of calls) {
      if (!knownCalls.has(c.id)) fresh = true;
      callsBar.append(h("div.k-call" + (c.kind === "bill" ? ".bill" : ""),
        icon(c.kind === "bill" ? "receipt" : "hand"),
        h("span", c.table_label + " · " + (c.kind === "bill" ? "Bill" + (c.payment_hint ? " (" + c.payment_hint + ")" : "") : "Waiter")),
        h("small", TT.timeAgo(c.created_at, now())),
        h("button", { onclick: () => resolveCall(c) }, "Done")));
    }
    if (fresh && knownCalls.size && sound) TT.chime("call");
    knownCalls = new Set(calls.map((c) => c.id));
  }

  // ------------------------------------------------------------ actions
  async function move(o, status, btn) {
    btn.disabled = true;
    const prev = o.status;
    o.status = status;           // optimistic
    render();
    try {
      await api.post("/api/s/orders/" + o.id + "/status", { status });
      if (status === "served") { delete doneLines[o.id]; store.set("tt_kds_done", doneLines); }
    } catch (e) {
      o.status = prev;
      render();
      toast(e.message, "error");
    }
  }

  async function resolveCall(c) {
    calls = calls.filter((x) => x.id !== c.id);
    renderCalls();
    try { await api.post("/api/s/calls/" + c.id + "/resolve", {}); }
    catch (e) { toast(e.message, "error"); }
  }

  function openRecall() {
    const done = orders.filter((o) => o.status === "served" || o.status === "cancelled").reverse();
    const m = TT.modal({
      title: "Recently completed",
      body: done.length ? h("div.k86", done.map((o) => h("div.k86-row",
        h("div", { style: { flex: 1 } }, h("div.strong", "#" + o.number + " · " + (o.table_label || "—")),
          h("div.cat", o.items.map((l) => l.qty + "× " + l.name).join(", "))),
        h("span.badge" + (o.status === "cancelled" ? ".danger" : ""), o.status),
        o.status === "served" ? h("button.btn.btn-sm", { onclick: async () => { await move(o, "ready", { disabled: false }); m.close(); } }, "Recall") : null)))
        : h("p.muted", "Orders served in the last 90 minutes show up here."),
    });
  }

  async function open86() {
    const m = TT.modal({ title: "Sold out (86) items", body: h("div", { style: { display: "grid", placeItems: "center", padding: "30px" } }, h("div.spinner")) });
    try {
      const res = await api.get("/api/s/menu-lite");
      const rows = res.items.map((it) => {
        const row = h("div.k86-row" + (it.available ? "" : ".off"),
          h("div", { style: { flex: 1 } }, h("div.nm.strong", it.name), h("div.cat", it.category)),
          h("label.switch", h("input", {
            type: "checkbox", checked: !!it.available,
            onchange: async (e) => {
              const on = e.target.checked;
              row.classList.toggle("off", !on);
              try { await api.post("/api/s/items/" + it.id + "/availability", { available: on }); toast(it.name + (on ? " is back on the menu" : " marked sold out"), on ? "ok" : "info"); }
              catch (err) { e.target.checked = !on; row.classList.toggle("off", on); toast(err.message, "error"); }
            },
          }), h("span.track"), h("span.small.muted", "In stock")));
        return row;
      });
      mount(m.body, h("p.muted.small", { style: { marginBottom: "8px" } }, "Switch off anything you've run out of — guests see it as sold out instantly."), h("div.k86", rows));
    } catch (e) { mount(m.body, h("p.field-error", e.message)); }
  }

  function fullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }

  // ------------------------------------------------------------ live loop
  async function loop() {
    for (;;) {
      try {
        const res = await api.get("/api/s/board?rev=" + rev + "&wait=" + (rev < 0 ? "0" : "1"));
        conn.classList.remove("off");
        if (res.changed) {
          orders = res.orders;
          calls = res.calls;
          clockSkew = res.server_time - Date.now() / 1000;
          render();
        }
        rev = res.rev;
      } catch (e) {
        conn.classList.add("off");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  function tick() {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $$(".el").forEach((el) => { el.textContent = TT.elapsed(+el.dataset.ts, now()); });
    $$(".ticket").forEach((tk) => {
      const o = orders.find((x) => String(x.id) === tk.dataset.id);
      if (o) { tk.classList.remove("age-ok", "age-warn", "age-late"); tk.classList.add(ageClass(o)); }
    });
  }
  setInterval(tick, 1000);
  tick();

  // Keep the screen awake while the display is visible.
  let lock = null;
  async function wake() {
    try { if ("wakeLock" in navigator && !document.hidden) lock = await navigator.wakeLock.request("screen"); } catch (_) { /* not allowed */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  wake();

  loop();
})();
