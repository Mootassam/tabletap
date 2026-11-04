/* TableTap customer menu. Everything the guest sees after scanning the table QR code. */
(function () {
  "use strict";
  const { h, icon, api, toast, store, readBoot, moneyFormatter, $, $$, mount, clear } = TT;

  const BOOT = readBoot();
  let R = BOOT.restaurant;
  const T = BOOT.table;
  let MENU = BOOT.menu || [];
  const money = moneyFormatter(R);

  // ================================================================ i18n
  const I18N = {
    en: {
      table: "Table", search: "Search the menu", noResults: "Nothing matches “{q}”", soldOut: "Sold out",
      servedBetween: "Served {hours}", addToOrder: "Add to order", add: "Add", required: "Required", optional: "Optional",
      chooseOne: "Choose 1", chooseUpTo: "Choose up to {n}", chooseAny: "Choose any", done: "Done",
      specialInstructions: "Special instructions", notePlaceholder: "e.g. no onions, sauce on the side",
      viewOrder: "View order", yourOrder: "Your order", subtotal: "Subtotal", service: "Service charge",
      tax: "Tax", taxIncluded: "Tax included", total: "Total", placeOrder: "Place order",
      orderNote: "Note for the kitchen", orderNotePlaceholder: "Allergies, timing, anything we should know",
      yourName: "Your name", yourNameOptional: "Your name (optional)", emptyCart: "Your order is empty",
      emptyCartSub: "Add something tasty from the menu.", backToMenu: "Back to menu",
      orderPlaced: "Order sent!", orderPlacedSub: "The kitchen has your order. Track it live below.",
      orderNumber: "Order #{n}", st_new: "Received", st_preparing: "Preparing", st_ready: "Ready", st_served: "Served",
      st_cancelled: "Cancelled", myOrders: "My orders", callWaiter: "Call waiter", requestBill: "Request bill",
      callWaiterSub: "Someone will come to your table", requestBillSub: "Pay at the table",
      howPay: "How would you like to pay?", cash: "Cash", card: "Card",
      waiterComing: "A waiter is on the way", billComing: "Your bill is on the way",
      closed: "Ordering is closed right now — you can still browse the menu.",
      browseOnly: "Scan the QR code on your table to order.", unavailable: "This menu is currently unavailable.",
      tableInactive: "This table isn't taking orders right now. Please ask a staff member.",
      wifi: "Wi-Fi", wifiCopied: "Wi-Fi password copied", networkError: "No connection — check the Wi-Fi",
      offline: "You're offline", remove: "Remove", keepBrowsing: "Keep browsing", howCanWeHelp: "How can we help?",
      allergens: "Contains", kcal: "kcal", mins: "~{n} min", paid: "Paid", visitTotal: "Total for this visit",
      readyMsg: "Your order #{n} is ready!", cancelledMsg: "Order #{n} was cancelled", nowUnavailable: "No longer available",
      fixCart: "Some items changed. Remove them to continue.", itemAdded: "Added to your order",
      orderAgain: "Add more items", nameRequired: "Please enter your name", sending: "Sending…", undo: "Undo",
      removed: "Removed", services: "Service", poweredBy: "Ordering by TableTap", noOrdersYet: "No orders yet from this phone.",
      tag_popular: "Popular", tag_new: "New", tag_chef: "Chef's pick", tag_spicy: "Spicy", tag_veg: "Vegetarian",
      tag_vegan: "Vegan", tag_gf: "Gluten-free", tag_halal: "Halal",
      al_gluten: "gluten", al_dairy: "dairy", al_eggs: "eggs", al_nuts: "nuts", al_peanuts: "peanuts", al_soy: "soy",
      al_fish: "fish", al_shellfish: "shellfish", al_sesame: "sesame", al_celery: "celery", al_mustard: "mustard",
    },
    fr: {
      table: "Table", search: "Rechercher dans le menu", noResults: "Aucun résultat pour « {q} »", soldOut: "Épuisé",
      servedBetween: "Servi {hours}", addToOrder: "Ajouter à la commande", add: "Ajouter", required: "Obligatoire", optional: "Facultatif",
      chooseOne: "Choisissez 1", chooseUpTo: "Jusqu'à {n}", chooseAny: "Au choix", done: "OK",
      specialInstructions: "Instructions particulières", notePlaceholder: "ex. sans oignons, sauce à part",
      viewOrder: "Voir la commande", yourOrder: "Votre commande", subtotal: "Sous-total", service: "Service",
      tax: "TVA", taxIncluded: "TVA incluse", total: "Total", placeOrder: "Commander",
      orderNote: "Note pour la cuisine", orderNotePlaceholder: "Allergies, timing, toute précision utile",
      yourName: "Votre prénom", yourNameOptional: "Votre prénom (facultatif)", emptyCart: "Votre commande est vide",
      emptyCartSub: "Ajoutez quelque chose de bon depuis le menu.", backToMenu: "Retour au menu",
      orderPlaced: "Commande envoyée !", orderPlacedSub: "La cuisine a reçu votre commande. Suivez-la en direct.",
      orderNumber: "Commande n°{n}", st_new: "Reçue", st_preparing: "En préparation", st_ready: "Prête", st_served: "Servie",
      st_cancelled: "Annulée", myOrders: "Mes commandes", callWaiter: "Appeler un serveur", requestBill: "Demander l'addition",
      callWaiterSub: "Quelqu'un arrive à votre table", requestBillSub: "Payer à table",
      howPay: "Comment souhaitez-vous payer ?", cash: "Espèces", card: "Carte",
      waiterComing: "Un serveur arrive", billComing: "Votre addition arrive",
      closed: "Les commandes sont fermées pour le moment — vous pouvez consulter le menu.",
      browseOnly: "Scannez le QR code de votre table pour commander.", unavailable: "Ce menu est momentanément indisponible.",
      tableInactive: "Cette table ne prend pas de commandes. Merci de demander au personnel.",
      wifi: "Wi-Fi", wifiCopied: "Mot de passe Wi-Fi copié", networkError: "Pas de connexion — vérifiez le Wi-Fi",
      offline: "Vous êtes hors ligne", remove: "Retirer", keepBrowsing: "Continuer", howCanWeHelp: "Comment pouvons-nous aider ?",
      allergens: "Contient", kcal: "kcal", mins: "~{n} min", paid: "Payée", visitTotal: "Total de la visite",
      readyMsg: "Votre commande n°{n} est prête !", cancelledMsg: "La commande n°{n} a été annulée", nowUnavailable: "Plus disponible",
      fixCart: "Certains articles ont changé. Retirez-les pour continuer.", itemAdded: "Ajouté à votre commande",
      orderAgain: "Ajouter d'autres articles", nameRequired: "Merci d'indiquer votre prénom", sending: "Envoi…", undo: "Annuler",
      removed: "Retiré", services: "Service", poweredBy: "Commande par TableTap", noOrdersYet: "Aucune commande depuis ce téléphone.",
      tag_popular: "Populaire", tag_new: "Nouveau", tag_chef: "Choix du chef", tag_spicy: "Épicé", tag_veg: "Végétarien",
      tag_vegan: "Vegan", tag_gf: "Sans gluten", tag_halal: "Halal",
      al_gluten: "gluten", al_dairy: "lait", al_eggs: "œufs", al_nuts: "fruits à coque", al_peanuts: "arachides", al_soy: "soja",
      al_fish: "poisson", al_shellfish: "crustacés", al_sesame: "sésame", al_celery: "céleri", al_mustard: "moutarde",
    },
    es: {
      table: "Mesa", search: "Buscar en el menú", noResults: "Nada coincide con «{q}»", soldOut: "Agotado",
      servedBetween: "Se sirve {hours}", addToOrder: "Añadir al pedido", add: "Añadir", required: "Obligatorio", optional: "Opcional",
      chooseOne: "Elige 1", chooseUpTo: "Hasta {n}", chooseAny: "A elegir", done: "Listo",
      specialInstructions: "Instrucciones especiales", notePlaceholder: "ej. sin cebolla, salsa aparte",
      viewOrder: "Ver pedido", yourOrder: "Tu pedido", subtotal: "Subtotal", service: "Servicio",
      tax: "IVA", taxIncluded: "IVA incluido", total: "Total", placeOrder: "Hacer pedido",
      orderNote: "Nota para la cocina", orderNotePlaceholder: "Alergias, tiempos, lo que debamos saber",
      yourName: "Tu nombre", yourNameOptional: "Tu nombre (opcional)", emptyCart: "Tu pedido está vacío",
      emptyCartSub: "Añade algo rico del menú.", backToMenu: "Volver al menú",
      orderPlaced: "¡Pedido enviado!", orderPlacedSub: "La cocina tiene tu pedido. Síguelo en directo.",
      orderNumber: "Pedido n.º {n}", st_new: "Recibido", st_preparing: "Preparando", st_ready: "Listo", st_served: "Servido",
      st_cancelled: "Cancelado", myOrders: "Mis pedidos", callWaiter: "Llamar al camarero", requestBill: "Pedir la cuenta",
      callWaiterSub: "Alguien vendrá a tu mesa", requestBillSub: "Pagar en la mesa",
      howPay: "¿Cómo quieres pagar?", cash: "Efectivo", card: "Tarjeta",
      waiterComing: "Un camarero va de camino", billComing: "Tu cuenta va de camino",
      closed: "Los pedidos están cerrados ahora — puedes ver el menú.",
      browseOnly: "Escanea el código QR de tu mesa para pedir.", unavailable: "Este menú no está disponible ahora.",
      tableInactive: "Esta mesa no acepta pedidos ahora. Pregunta al personal.",
      wifi: "Wi-Fi", wifiCopied: "Contraseña Wi-Fi copiada", networkError: "Sin conexión — revisa el Wi-Fi",
      offline: "Sin conexión", remove: "Quitar", keepBrowsing: "Seguir viendo", howCanWeHelp: "¿En qué podemos ayudarte?",
      allergens: "Contiene", kcal: "kcal", mins: "~{n} min", paid: "Pagado", visitTotal: "Total de la visita",
      readyMsg: "¡Tu pedido n.º {n} está listo!", cancelledMsg: "El pedido n.º {n} fue cancelado", nowUnavailable: "Ya no disponible",
      fixCart: "Algunos productos cambiaron. Quítalos para continuar.", itemAdded: "Añadido a tu pedido",
      orderAgain: "Añadir más", nameRequired: "Escribe tu nombre", sending: "Enviando…", undo: "Deshacer",
      removed: "Quitado", services: "Servicio", poweredBy: "Pedidos con TableTap", noOrdersYet: "Aún no hay pedidos desde este teléfono.",
      tag_popular: "Popular", tag_new: "Nuevo", tag_chef: "Del chef", tag_spicy: "Picante", tag_veg: "Vegetariano",
      tag_vegan: "Vegano", tag_gf: "Sin gluten", tag_halal: "Halal",
      al_gluten: "gluten", al_dairy: "lácteos", al_eggs: "huevo", al_nuts: "frutos secos", al_peanuts: "cacahuete", al_soy: "soja",
      al_fish: "pescado", al_shellfish: "marisco", al_sesame: "sésamo", al_celery: "apio", al_mustard: "mostaza",
    },
    ar: {
      table: "طاولة", search: "ابحث في القائمة", noResults: "لا توجد نتائج لـ «{q}»", soldOut: "نفد",
      servedBetween: "يُقدَّم {hours}", addToOrder: "أضف إلى الطلب", add: "أضف", required: "إلزامي", optional: "اختياري",
      chooseOne: "اختر 1", chooseUpTo: "حتى {n}", chooseAny: "اختر ما تشاء", done: "تم",
      specialInstructions: "تعليمات خاصة", notePlaceholder: "مثال: بدون بصل، الصلصة جانبًا",
      viewOrder: "عرض الطلب", yourOrder: "طلبك", subtotal: "المجموع الفرعي", service: "رسوم الخدمة",
      tax: "الضريبة", taxIncluded: "شامل الضريبة", total: "المجموع", placeOrder: "أرسل الطلب",
      orderNote: "ملاحظة للمطبخ", orderNotePlaceholder: "حساسية، توقيت، أي شيء يجب أن نعرفه",
      yourName: "اسمك", yourNameOptional: "اسمك (اختياري)", emptyCart: "طلبك فارغ",
      emptyCartSub: "أضف شيئًا لذيذًا من القائمة.", backToMenu: "العودة إلى القائمة",
      orderPlaced: "تم إرسال الطلب!", orderPlacedSub: "وصل طلبك إلى المطبخ. تابعه مباشرة أدناه.",
      orderNumber: "طلب رقم {n}", st_new: "تم الاستلام", st_preparing: "قيد التحضير", st_ready: "جاهز", st_served: "تم التقديم",
      st_cancelled: "ملغى", myOrders: "طلباتي", callWaiter: "نادِ النادل", requestBill: "اطلب الفاتورة",
      callWaiterSub: "سيأتي أحدنا إلى طاولتك", requestBillSub: "الدفع على الطاولة",
      howPay: "كيف تريد الدفع؟", cash: "نقدًا", card: "بطاقة",
      waiterComing: "النادل في الطريق إليك", billComing: "فاتورتك في الطريق",
      closed: "الطلبات مغلقة حاليًا — يمكنك تصفح القائمة.",
      browseOnly: "امسح رمز QR الموجود على طاولتك للطلب.", unavailable: "هذه القائمة غير متاحة حاليًا.",
      tableInactive: "هذه الطاولة لا تستقبل الطلبات الآن. يرجى سؤال الموظفين.",
      wifi: "واي فاي", wifiCopied: "تم نسخ كلمة مرور الواي فاي", networkError: "لا يوجد اتصال — تحقق من الواي فاي",
      offline: "أنت غير متصل", remove: "إزالة", keepBrowsing: "متابعة التصفح", howCanWeHelp: "كيف يمكننا مساعدتك؟",
      allergens: "يحتوي على", kcal: "سعرة", mins: "~{n} دقيقة", paid: "مدفوع", visitTotal: "مجموع الزيارة",
      readyMsg: "طلبك رقم {n} جاهز!", cancelledMsg: "تم إلغاء الطلب رقم {n}", nowUnavailable: "لم يعد متاحًا",
      fixCart: "تغيّرت بعض الأصناف. أزلها للمتابعة.", itemAdded: "أُضيف إلى طلبك",
      orderAgain: "أضف المزيد", nameRequired: "يرجى إدخال اسمك", sending: "جارٍ الإرسال…", undo: "تراجع",
      removed: "أُزيل", services: "الخدمة", poweredBy: "الطلب عبر TableTap", noOrdersYet: "لا توجد طلبات من هذا الهاتف بعد.",
      tag_popular: "الأكثر طلبًا", tag_new: "جديد", tag_chef: "اختيار الشيف", tag_spicy: "حار", tag_veg: "نباتي",
      tag_vegan: "نباتي صرف", tag_gf: "خالٍ من الغلوتين", tag_halal: "حلال",
      al_gluten: "غلوتين", al_dairy: "حليب", al_eggs: "بيض", al_nuts: "مكسرات", al_peanuts: "فول سوداني", al_soy: "صويا",
      al_fish: "سمك", al_shellfish: "قشريات", al_sesame: "سمسم", al_celery: "كرفس", al_mustard: "خردل",
    },
  };
  const LANG_NAMES = { en: "EN", fr: "FR", es: "ES", ar: "عربي" };
  let lang = store.get("tt_lang", null);
  if (!I18N[lang]) lang = I18N[R.language] ? R.language : "en";

  function t(key, vars) {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  }

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }

  // Accent ink: dark text on light accent colors, white on dark ones.
  (function accentInk() {
    const hex = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "").trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return;
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    if (lum > 0.66) document.documentElement.style.setProperty("--accent-ink", "#1c1b19");
  })();

  // ================================================================ state
  const scope = T ? T.token : "r_" + R.slug;
  const CART_KEY = "tt_cart_" + scope;
  const ORD_KEY = "tt_orders_" + scope;
  let cart = store.get(CART_KEY, []);
  let tracked = store.get(ORD_KEY, []).filter((o) => o && o.token && Date.now() / 1000 - o.at < 12 * 3600);
  const orders = {};
  let items = new Map();       // id -> item
  let itemCat = new Map();     // id -> category
  let searchQ = "";
  let searching = false;
  const sentCalls = {};        // kind -> timestamp

  const canOrder = () => !!T && T.active && R.ordering_open && R.available;

  function indexMenu() {
    items = new Map();
    itemCat = new Map();
    for (const c of MENU) for (const it of c.items) { items.set(it.id, it); itemCat.set(it.id, c); }
  }
  indexMenu();

  function saveCart() { store.set(CART_KEY, cart); }
  function saveTracked() { store.set(ORD_KEY, tracked); }

  // ================================================================ pricing (display only — the server re-prices)
  function unitPrice(it, opts) {
    let p = it.price;
    for (const g of it.options || []) {
      for (const cid of (opts && opts[g.id]) || []) {
        const c = g.choices.find((x) => x.id === cid);
        if (c) p += c.price;
      }
    }
    return p;
  }

  function lineProblem(line) {
    const it = items.get(line.item_id);
    if (!it) return t("nowUnavailable");
    if (!it.available) return t("soldOut");
    const cat = itemCat.get(it.id);
    if (cat && !cat.open) return t("servedBetween", { hours: cat.hours });
    const groups = it.options || [];
    for (const gid in line.options || {}) if (!groups.find((g) => g.id === gid)) return t("nowUnavailable");
    for (const g of groups) {
      const sel = (line.options && line.options[g.id]) || [];
      if (sel.some((cid) => !g.choices.find((c) => c.id === cid))) return t("nowUnavailable");
      if (g.required && !sel.length) return t("nowUnavailable");
    }
    return null;
  }

  function totals(sub) {
    const service = Math.floor((sub * R.service_rate + 5000) / 10000);
    const rate = R.tax_rate;
    let tax = 0, total = sub + service;
    if (rate > 0) {
      if (R.tax_inclusive) tax = total - Math.floor((total * 10000 + Math.floor((10000 + rate) / 2)) / (10000 + rate));
      else { tax = Math.floor(((sub + service) * rate + 5000) / 10000); total += tax; }
    }
    return { sub, service, tax, total };
  }

  function cartCount() { return cart.reduce((a, l) => a + l.qty, 0); }
  function cartSubtotal() {
    return cart.reduce((a, l) => { const it = items.get(l.item_id); return a + (it ? unitPrice(it, l.options) * l.qty : 0); }, 0);
  }
  function qtyInCart(id) { return cart.filter((l) => l.item_id === id).reduce((a, l) => a + l.qty, 0); }

  function lineKey(itemId, opts, note) {
    const o = Object.keys(opts || {}).sort().map((k) => k + ":" + [...opts[k]].sort().join("|")).join(";");
    return itemId + "#" + o + "#" + (note || "").trim().toLowerCase();
  }

  function addToCart(it, qty, opts, note) {
    const key = lineKey(it.id, opts, note);
    const existing = cart.find((l) => l.key === key);
    if (existing) existing.qty = Math.min(50, existing.qty + qty);
    else cart.push({ key, item_id: it.id, qty, options: opts || {}, note: (note || "").trim() });
    saveCart();
    refreshDock();
    refreshItemBadge(it.id, true);
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function optionSummary(it, opts) {
    const parts = [];
    for (const g of (it && it.options) || []) {
      for (const cid of (opts && opts[g.id]) || []) {
        const c = g.choices.find((x) => x.id === cid);
        if (c) parts.push(c.name);
      }
    }
    return parts.join(", ");
  }

  // ================================================================ sheets (bottom sheets with back-button support)
  const sheets = [];
  let ignorePop = 0;

  function openSheet(build, opts = {}) {
    const back = h("div.sheet-back", { onclick: () => closeSheet() });
    const sheet = h("div.sheet", { role: "dialog", "aria-modal": "true" });
    document.body.append(back, sheet);
    document.body.style.overflow = "hidden";
    const s = { back, sheet, onClose: opts.onClose };
    sheets.push(s);
    history.pushState({ ttSheet: sheets.length }, "");
    fill(s, build);
    return s;
  }

  function fill(s, build) {
    clear(s.sheet);
    s.sheet.append(
      h("button.sheet-close", { "aria-label": "Close", onclick: () => closeSheet() }, icon("x")),
      ...[].concat(build(s)));
    setTimeout(() => s.sheet.querySelector(".sheet-scroll")?.scrollTo(0, 0), 0);
  }

  function replaceTop(build) {
    const s = sheets[sheets.length - 1];
    if (s) fill(s, build); else openSheet(build);
  }

  function closeSheet(fromPop) {
    const s = sheets.pop();
    if (!s) return;
    s.back.classList.add("out");
    s.sheet.classList.add("out");
    setTimeout(() => { s.back.remove(); s.sheet.remove(); }, 240);
    if (!sheets.length) document.body.style.overflow = "";
    if (!fromPop) { ignorePop++; history.back(); }
    if (s.onClose) s.onClose();
  }

  window.addEventListener("popstate", () => {
    if (ignorePop > 0) { ignorePop--; return; }
    if (sheets.length) closeSheet(true);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheets.length) closeSheet(); });

  // ================================================================ layout
  const app = h("div.app");
  const sectionsBox = h("div.sections");
  const dock = h("div.dock");
  let navEl, tabsEl, searchBarEl;

  function render() {
    applyLang();
    const root = document.getElementById("app");
    mount(app);
    app.append(renderHero());
    if (!R.available) {
      app.append(h("div.notice", icon("alert"), h("span", t("unavailable"))));
    } else {
      if (!T) app.append(h("div.notice.info", icon("qr"), h("span", t("browseOnly"))));
      else if (!T.active) app.append(h("div.notice", icon("alert"), h("span", t("tableInactive"))));
      else if (!R.ordering_open) app.append(h("div.notice", icon("clock"), h("span", R.closed_message || t("closed"))));
      app.append(h("div.sentinel"), renderNav(), sectionsBox);
      renderSections();
      app.append(h("div.footer-note", t("poweredBy")));
    }
    mount(root, app);
    document.body.appendChild(dock);
    refreshDock();
    observe();
  }

  function renderHero() {
    const cover = h("div.hero-cover" + (R.cover ? ".has-img" : ""), R.cover ? h("img", { src: "/u/" + R.cover, alt: "" }) : null);
    const sel = h("select", { "aria-label": "Language", onchange: (e) => { lang = e.target.value; store.set("tt_lang", lang); render(); } },
      Object.keys(I18N).map((k) => h("option", { value: k, selected: k === lang }, LANG_NAMES[k])));
    cover.append(h("div.lang-select", sel));
    const chips = h("div.hero-chips");
    if (T) chips.append(h("span.hchip.table", icon("utensils"), T.label));
    if (R.wifi_name) {
      chips.append(h("button.hchip", {
        onclick: async () => {
          if (R.wifi_password && await TT.copyText(R.wifi_password)) toast(t("wifiCopied") + " · " + R.wifi_password, "ok");
          else toast(R.wifi_name + (R.wifi_password ? " · " + R.wifi_password : ""), "info");
        },
      }, icon("wifi"), R.wifi_name));
    }
    if (R.phone) chips.append(h("a.hchip", { href: "tel:" + R.phone.replace(/[^\d+]/g, "") }, icon("phone"), R.phone));
    if (R.address) chips.append(h("span.hchip", icon("pin"), R.address));
    const logo = h("div.hero-logo", R.logo ? h("img", { src: "/u/" + R.logo, alt: "" }) : (R.name || "?").trim().charAt(0).toUpperCase());
    return h("div.hero", cover, h("div.hero-card",
      h("div.hero-top", logo, h("div", h("h1.hero-name", R.name), R.tagline ? h("div.hero-tag", R.tagline) : null)),
      chips.childNodes.length ? chips : null));
  }

  function renderNav() {
    tabsEl = h("div.tabs", { role: "tablist" }, MENU.map((c, i) =>
      h("button.tab" + (i === 0 ? ".active" : ""), {
        role: "tab", dataset: { cat: c.id },
        onclick: () => {
          if (searching) closeSearch();
          const sec = document.getElementById("cat-" + c.id);
          if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      }, c.icon ? h("span.ti", c.icon) : null, c.name)));
    const searchInput = h("input.input", {
      type: "search", placeholder: t("search"), "aria-label": t("search"), value: searchQ, enterkeyhint: "search",
      oninput: TT.debounce((e) => { searchQ = e.target.value; renderSections(); }, 120),
    });
    searchBarEl = h("div.searchbar", { hidden: !searching }, searchInput,
      h("button.btn.btn-ghost", { onclick: closeSearch }, t("done")));
    navEl = h("nav.catnav",
      h("div.catnav-inner", { hidden: searching },
        h("button.search-btn", { "aria-label": t("search"), onclick: openSearch }, icon("search")),
        h("div.catnav-title", R.name),
        tabsEl),
      searchBarEl);
    return navEl;
  }

  function openSearch() {
    searching = true;
    navEl.querySelector(".catnav-inner").hidden = true;
    searchBarEl.hidden = false;
    const inp = searchBarEl.querySelector("input");
    inp.focus();
    navEl.scrollIntoView({ block: "start" });
  }

  function closeSearch() {
    searching = false;
    searchQ = "";
    searchBarEl.querySelector("input").value = "";
    searchBarEl.hidden = true;
    navEl.querySelector(".catnav-inner").hidden = false;
    renderSections();
  }

  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function renderSections() {
    clear(sectionsBox);
    const q = norm(searchQ.trim());
    let shown = 0;
    for (const c of MENU) {
      const list = q ? c.items.filter((it) => norm(it.name + " " + it.description).includes(q)) : c.items;
      if (!list.length) continue;
      shown += list.length;
      const sec = h("section.section" + (c.open ? "" : ".closed"), { id: "cat-" + c.id, dataset: { cat: c.id } },
        h("div.section-head", h("h2", c.icon ? c.icon + " " + c.name : c.name),
          !c.open ? h("span.badge.warn", icon("clock", "icon"), t("servedBetween", { hours: c.hours })) : null),
        c.description ? h("p.section-desc", c.description) : null,
        list.map((it) => itemRow(it, c)));
      sectionsBox.append(sec);
    }
    if (!shown) {
      sectionsBox.append(h("div.no-results", icon("search", "icon"), h("p", q ? t("noResults", { q: searchQ }) : "")));
    }
  }

  function tagChip(tag) {
    const ic = { popular: "star", chef: "sparkles", spicy: "flame", veg: "leaf", vegan: "leaf", new: "zap" }[tag];
    return h("span.tag." + tag, ic ? icon(ic) : null, t("tag_" + tag));
  }

  function mediaFor(it, cls) {
    if (it.image) return h("img." + cls[0], { src: "/u/" + it.image, alt: "", loading: "lazy", decoding: "async" });
    return h("div." + cls[1], { "aria-hidden": "true" }, it.emoji || (it.name || "?").charAt(0).toUpperCase());
  }

  function priceEl(it) {
    const promo = it.compare_price && it.compare_price > it.price;
    return [h("span.price" + (promo ? ".price-promo" : ""), money(it.price)), promo ? h("span.price-was", money(it.compare_price)) : null];
  }

  function itemRow(it, c) {
    const soldOut = !it.available;
    const q = qtyInCart(it.id);
    const addBtn = canOrder() && !soldOut && c.open
      ? h("button.item-add" + (q ? ".has" : ""), {
          "aria-label": t("add") + " " + it.name, dataset: { add: it.id },
          onclick: (e) => {
            e.stopPropagation();
            if ((it.options || []).length) openItem(it);
            else { addToCart(it, 1, {}, ""); toast(t("itemAdded") + " · " + it.name, "ok", { duration: 1600 }); }
          },
        }, q ? String(q) : icon("plus"))
      : null;
    const meta = h("div.item-meta", priceEl(it), (it.tags || []).slice(0, 3).map(tagChip));
    return h("article.item" + (soldOut ? ".soldout" : ""), {
      dataset: { item: it.id }, tabindex: "0",
      onclick: () => openItem(it),
      onkeydown: (e) => { if (e.key === "Enter") openItem(it); },
    },
      h("div", h("h3.item-name", it.name), it.description ? h("p.item-desc", it.description) : null, meta),
      h("div.item-media", mediaFor(it, ["item-img", "item-emoji"]), soldOut ? h("span.so-badge", t("soldOut")) : null, addBtn));
  }

  function refreshItemBadge(id, bump) {
    $$('[data-add="' + id + '"]').forEach((b) => {
      const q = qtyInCart(id);
      b.classList.toggle("has", q > 0);
      mount(b, q ? String(q) : icon("plus"));
      if (bump) { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }
    });
  }

  // Scroll spy + sticky shadow.
  let spy, stickyObs;
  function observe() {
    if (spy) spy.disconnect();
    if (stickyObs) stickyObs.disconnect();
    const sentinel = $(".sentinel", app);
    if (!navEl || !sentinel) return;
    stickyObs = new IntersectionObserver(([e]) => navEl.classList.toggle("stuck", !e.isIntersecting));
    stickyObs.observe(sentinel);
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.dataset.cat;
        $$(".tab", tabsEl).forEach((tb) => {
          const on = tb.dataset.cat === id;
          tb.classList.toggle("active", on);
          if (on) {
            const rel = tb.getBoundingClientRect().left - tabsEl.getBoundingClientRect().left;
            const left = tabsEl.scrollLeft + rel - tabsEl.clientWidth / 2 + tb.clientWidth / 2;
            tabsEl.scrollTo({ left, behavior: "smooth" });
          }
        });
      }
    }, { rootMargin: "-80px 0px -65% 0px" });
    $$(".section", sectionsBox).forEach((s) => spy.observe(s));
  }

  // ================================================================ item detail
  function openItem(it, editLine) {
    const cat = itemCat.get(it.id);
    const orderable = canOrder() && it.available && (!cat || cat.open);
    const sel = {};
    for (const g of it.options || []) sel[g.id] = editLine ? [...((editLine.options || {})[g.id] || [])] : [];
    let qty = editLine ? editLine.qty : 1;
    let note = editLine ? editLine.note : "";
    const groupEls = {};

    openSheet(() => {
      const addBtn = h("button.btn.btn-primary.btn-lg", { onclick: submit });
      const qtyEl = h("span.qty", String(qty));
      const minus = h("button", { "aria-label": "−", onclick: () => { if (qty > 1) { qty--; sync(); } } }, icon("minus"));
      const plus = h("button", { "aria-label": "+", onclick: () => { if (qty < 50) { qty++; sync(); } } }, icon("plus"));

      function sync() {
        qtyEl.textContent = qty;
        minus.disabled = qty <= 1;
        mount(addBtn, h("span", editLine ? t("done") : t("addToOrder")), h("span.num", money(unitPrice(it, sel) * qty)));
        for (const g of it.options || []) {
          const el = groupEls[g.id];
          if (!el) continue;
          const n = sel[g.id].length;
          const badge = el.querySelector(".req");
          if (g.required) {
            badge.className = "req " + (n ? "done" : "need");
            mount(badge, n ? icon("check", "icon") : null, n ? "" : t("required"));
          }
          if (g.type === "multi" && g.max) {
            el.querySelectorAll(".choice").forEach((ch) => {
              const inp = ch.querySelector("input");
              const block = !inp.checked && n >= g.max;
              ch.classList.toggle("disabled", block);
              inp.disabled = block;
            });
          }
        }
      }

      function submit() {
        for (const g of it.options || []) {
          if (g.required && !sel[g.id].length) {
            const el = groupEls[g.id];
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
            if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
            return;
          }
        }
        const opts = {};
        for (const gid in sel) if (sel[gid].length) opts[gid] = sel[gid];
        if (editLine) {
          cart = cart.filter((l) => l !== editLine);
          saveCart();
        }
        addToCart(it, qty, opts, note);
        closeSheet();
        if (!editLine) toast(t("itemAdded") + " · " + it.name, "ok", { duration: 1600 });
        else if (sheets.length) replaceTop(cartView);
      }

      const facts = [];
      if (it.prep_minutes) facts.push(h("span.fact", icon("clock"), t("mins", { n: it.prep_minutes })));
      if (it.calories) facts.push(h("span.fact", icon("zap"), it.calories + " " + t("kcal")));
      const tags = (it.tags || []).map(tagChip);

      const groups = (it.options || []).map((g) => {
        const sub = g.type === "single" ? t("chooseOne") : g.max ? t("chooseUpTo", { n: g.max }) : t("chooseAny");
        const el = h("div.og",
          h("div.og-head", h("div", h("h4", g.name), h("div.og-sub", sub)),
            h("span.req" + (g.required ? ".need" : ""), g.required ? t("required") : t("optional"))),
          g.choices.map((c) => {
            const inp = h("input", {
              type: g.type === "single" ? "radio" : "checkbox", name: "g_" + g.id, value: c.id,
              checked: sel[g.id].includes(c.id),
              onchange: () => {
                if (g.type === "single") sel[g.id] = [c.id];
                else sel[g.id] = inp.checked ? [...sel[g.id], c.id] : sel[g.id].filter((x) => x !== c.id);
                sync();
              },
            });
            return h("label.choice" + (g.type === "multi" ? ".multi" : ""), inp, h("span.mark", icon("check")),
              h("span.cname", c.name), c.price ? h("span.cprice", "+" + money(c.price)) : null);
          }));
        groupEls[g.id] = el;
        return el;
      });

      const allergens = (it.allergens || []).length
        ? h("p.allergen-line", h("b", t("allergens") + ": "), it.allergens.map((a) => t("al_" + a)).join(", ")) : null;

      const noteEl = orderable ? h("div.note-box.field",
        h("label", t("specialInstructions")),
        h("textarea.textarea", { maxlength: 200, placeholder: t("notePlaceholder"), oninput: (e) => { note = e.target.value; } }, note)) : null;

      const body = h("div.sheet-scroll",
        h("div.detail-media" + (it.image ? "" : ".emoji"), it.image ? h("img", { src: "/u/" + it.image, alt: "" }) : (it.emoji || it.name.charAt(0))),
        h("div.sheet-pad",
          h("h2.sheet-title", it.name),
          h("div.item-meta", priceEl(it), !it.available ? h("span.badge.danger", t("soldOut")) : null,
            cat && !cat.open ? h("span.badge.warn", t("servedBetween", { hours: cat.hours })) : null),
          it.description ? h("p.detail-desc", it.description) : null,
          facts.length || tags.length ? h("div.detail-facts", tags, facts) : null,
          allergens,
          orderable ? groups : null,
          noteEl));

      const foot = orderable
        ? h("div.sheet-foot", h("div.add-row", h("div.stepper", minus, qtyEl, plus), addBtn))
        : null;
      setTimeout(sync, 0);
      return [h("div.sheet-grab"), body, foot];
    });
  }

  // ================================================================ cart
  function cartView() {
    if (!cart.length) {
      return [h("div.sheet-grab"), h("div.sheet-scroll", h("div.empty",
        h("div.empty-icon", icon("bag")), h("h3", t("emptyCart")), h("p", t("emptyCartSub")),
        h("button.btn.btn-primary", { style: { marginTop: "16px" }, onclick: () => closeSheet() }, t("backToMenu"))))];
    }
    let anyBad = false;
    const lines = cart.map((l) => {
      const it = items.get(l.item_id);
      const problem = lineProblem(l);
      if (problem) anyBad = true;
      const qtyEl = h("span.qty", String(l.qty));
      const step = h("div.stepper.sm",
        h("button", { "aria-label": "−", onclick: () => changeQty(l, -1) }, icon(l.qty === 1 ? "trash" : "minus")),
        qtyEl,
        h("button", { "aria-label": "+", disabled: !!problem, onclick: () => changeQty(l, 1) }, icon("plus")));
      const name = it ? it.name : "—";
      return h("div.cline" + (problem ? ".bad" : ""),
        h("div.cline-main", { onclick: () => { if (it && !problem) openItem(it, l); }, style: { cursor: problem ? "default" : "pointer" } },
          h("div.cline-name", name),
          it && optionSummary(it, l.options) ? h("div.cline-opts", optionSummary(it, l.options)) : null,
          l.note ? h("div.cline-note", "“" + l.note + "”") : null,
          problem ? h("div.field-error", problem) : null),
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" } },
          h("span.cline-price", it ? money(unitPrice(it, l.options) * l.qty) : ""),
          problem ? h("button.btn.btn-sm.btn-danger", { onclick: () => removeLine(l) }, t("remove")) : step));
    });

    const tt = totals(cartSubtotal());
    const trows = [h("div.trow", h("span", t("subtotal")), h("span", money(tt.sub)))];
    if (tt.service) trows.push(h("div.trow", h("span", t("service") + " (" + R.service_rate / 100 + "%)"), h("span", money(tt.service))));
    if (tt.tax && !R.tax_inclusive) trows.push(h("div.trow", h("span", t("tax") + " (" + R.tax_rate / 100 + "%)"), h("span", money(tt.tax))));
    trows.push(h("div.trow.grand", h("span", t("total")), h("span", money(tt.total))));
    if (tt.tax && R.tax_inclusive) trows.push(h("div.trow", h("span.tiny", t("taxIncluded") + " (" + R.tax_rate / 100 + "%)"), h("span.tiny", money(tt.tax))));

    const draft = store.get("tt_draft_" + scope, { name: "", note: "" });
    const nameIn = h("input.input", {
      name: "name", maxlength: 60, autocomplete: "given-name", value: draft.name,
      placeholder: R.require_name ? t("yourName") : t("yourNameOptional"),
      oninput: (e) => { draft.name = e.target.value; store.set("tt_draft_" + scope, draft); },
    });
    const noteIn = h("textarea.textarea", {
      name: "note", maxlength: 300, placeholder: t("orderNotePlaceholder"),
      oninput: (e) => { draft.note = e.target.value; store.set("tt_draft_" + scope, draft); },
    }, draft.note);

    const placeBtn = h("button.btn.btn-primary.btn-lg.btn-block", {
      disabled: anyBad || !canOrder(),
      onclick: () => placeOrder(placeBtn, nameIn, noteIn),
    }, h("span", t("placeOrder")), h("span.num", "· " + money(tt.total)));

    return [h("div.sheet-grab"),
      h("div.sheet-scroll", h("div.sheet-pad",
        h("h2.sheet-title", t("yourOrder")),
        T ? h("p.muted.small", t("table") + ": " + T.label) : null,
        anyBad ? h("div.notice", { style: { margin: "12px 0 0" } }, icon("alert"), h("span", t("fixCart"))) : null,
        h("div", { style: { marginTop: "8px" } }, lines),
        h("div.totals", trows),
        h("div.stack", { style: { marginTop: "20px" } },
          h("div.field", h("label", R.require_name ? t("yourName") : t("yourNameOptional")), nameIn),
          h("div.field", h("label", t("orderNote")), noteIn)))),
      h("div.sheet-foot", placeBtn)];
  }

  function changeQty(line, d) {
    line.qty += d;
    if (line.qty <= 0) return removeLine(line);
    saveCart();
    refreshDock();
    refreshItemBadge(line.item_id);
    replaceTop(cartView);
  }

  function removeLine(line) {
    const idx = cart.indexOf(line);
    if (idx < 0) return;
    cart.splice(idx, 1);
    saveCart();
    refreshDock();
    refreshItemBadge(line.item_id);
    replaceTop(cartView);
    toast(t("removed"), "info", {
      action: { label: t("undo"), run: () => { cart.splice(idx, 0, line); saveCart(); refreshDock(); refreshItemBadge(line.item_id); if (sheets.length) replaceTop(cartView); } },
    });
  }

  async function placeOrder(btn, nameIn, noteIn) {
    const name = nameIn.value.trim();
    if (R.require_name && !name) {
      nameIn.classList.add("invalid");
      nameIn.focus();
      toast(t("nameRequired"), "error");
      return;
    }
    const payload = {
      name, note: noteIn.value.trim(),
      items: cart.map((l) => ({ item_id: l.item_id, qty: l.qty, options: l.options, note: l.note })),
    };
    await TT.withBusy(btn, async () => {
      try {
        const res = await api.post("/api/p/order/" + encodeURIComponent(T.token), payload);
        const o = res.order;
        orders[o.token] = o;
        tracked.unshift({ token: o.token, at: Math.floor(Date.now() / 1000) });
        saveTracked();
        cart = [];
        saveCart();
        store.set("tt_draft_" + scope, { name, note: "" });
        refreshDock();
        MENU.forEach((c) => c.items.forEach((it) => refreshItemBadge(it.id)));
        if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
        replaceTop(() => successView(o));
        schedulePoll(4000);
      } catch (e) {
        if (["sold_out", "item_gone", "options_changed", "not_now", "option_required"].includes(e.code)) {
          await refreshMenu();
          replaceTop(cartView);
        } else if (e.code === "closed" || e.code === "unavailable") {
          await refreshMenu();
        }
        toast(e.code === "network" ? t("networkError") : e.message, "error");
      }
    });
  }

  // ================================================================ orders & tracking
  const STEPS = ["new", "preparing", "ready", "served"];

  function trackCard(o) {
    const idx = STEPS.indexOf(o.status);
    const cancelled = o.status === "cancelled";
    const steps = h("div.steps", STEPS.map((s, i) => {
      const cls = cancelled ? "" : i < idx || (i === idx && s === "served") ? ".done" : i === idx ? ".current" : "";
      return h("div.step" + cls, h("div.bar"), t("st_" + s));
    }));
    const summary = o.items.map((i) => i.qty + "× " + i.name).join(", ");
    return h("div.track" + (cancelled ? ".cancelled" : ""),
      h("div.track-head",
        h("span.num", t("orderNumber", { n: o.number })),
        h("span.spacer"),
        o.paid ? h("span.badge.ok", t("paid")) : null,
        h("span.badge" + (cancelled ? ".danger" : o.status === "ready" ? ".ok" : o.status === "served" ? "" : ".accent"), t("st_" + o.status))),
      cancelled ? null : steps,
      o.status === "ready" ? h("div.ready-banner", icon("bell"), t("readyMsg", { n: o.number })) : null,
      h("div.track-items", summary),
      h("div.trow", { style: { marginTop: "8px" } }, h("span", TT.fmtTime(o.created_at)), h("span.strong", money(o.total))));
  }

  function successView(o) {
    return [h("div.sheet-grab"), h("div.sheet-scroll", h("div.sheet-pad",
      h("div.success",
        h("div.success-check", icon("check")),
        h("h2", t("orderPlaced")),
        h("p.muted", { style: { marginTop: "6px" } }, t("orderPlacedSub")),
        h("span.order-no", t("orderNumber", { n: o.number }))),
      h("div.live-track", { dataset: { token: o.token } }, trackCard(o)))),
      h("div.sheet-foot", h("div.row",
        h("button.btn.btn-soft.btn-lg", { style: { flex: 1 }, onclick: () => { closeSheet(); } }, t("orderAgain")),
        h("button.btn.btn-dark.btn-lg", { style: { flex: 1 }, onclick: () => replaceTop(ordersView) }, t("myOrders"))))];
  }

  function ordersView() {
    const list = tracked.map((x) => orders[x.token]).filter(Boolean);
    const visit = list.filter((o) => o.status !== "cancelled").reduce((a, o) => a + o.total, 0);
    return [h("div.sheet-grab"), h("div.sheet-scroll", h("div.sheet-pad",
      h("h2.sheet-title", t("myOrders")),
      list.length ? h("div.live-list", list.map(trackCard)) : h("p.muted", { style: { marginTop: "12px" } }, t("noOrdersYet")),
      list.length ? h("div.totals", h("div.trow.grand", h("span", t("visitTotal")), h("span", money(visit)))) : null,
      T ? serviceCards() : null))];
  }

  function serviceCards() {
    const recently = (k) => sentCalls[k] && Date.now() - sentCalls[k] < 3 * 60 * 1000;
    return h("div.svc-grid",
      h("button.svc-card" + (recently("waiter") ? ".sent" : ""), { onclick: () => sendCall("waiter") },
        h("span.ic", icon(recently("waiter") ? "check" : "hand")), t("callWaiter"),
        h("small", recently("waiter") ? t("waiterComing") : t("callWaiterSub"))),
      h("button.svc-card" + (recently("bill") ? ".sent" : ""), { onclick: () => recently("bill") ? null : replaceTop(payView) },
        h("span.ic", icon(recently("bill") ? "check" : "receipt")), t("requestBill"),
        h("small", recently("bill") ? t("billComing") : t("requestBillSub"))));
  }

  function serviceView() {
    return [h("div.sheet-grab"), h("div.sheet-scroll", h("div.sheet-pad",
      h("h2.sheet-title", t("howCanWeHelp")),
      T ? h("p.muted.small", t("table") + ": " + T.label) : null,
      serviceCards(),
      tracked.length ? h("button.btn.btn-soft.btn-block", { style: { marginTop: "14px" }, onclick: () => replaceTop(ordersView) },
        icon("receipt"), t("myOrders")) : null))];
  }

  function payView() {
    return [h("div.sheet-grab"), h("div.sheet-scroll", h("div.sheet-pad",
      h("h2.sheet-title", t("requestBill")),
      h("p.muted", { style: { marginTop: "6px" } }, t("howPay")),
      h("div.pay-choice",
        h("button.svc-card", { onclick: () => sendCall("bill", "cash") }, h("span.ic", icon("cash")), t("cash")),
        h("button.svc-card", { onclick: () => sendCall("bill", "card") }, h("span.ic", icon("card")), t("card")))))];
  }

  async function sendCall(kind, payment) {
    try {
      await api.post("/api/p/call/" + encodeURIComponent(T.token), { kind, payment });
      sentCalls[kind] = Date.now();
      toast(kind === "bill" ? t("billComing") : t("waiterComing"), "ok");
      if (navigator.vibrate) navigator.vibrate(25);
      replaceTop(serviceView);
    } catch (e) {
      if (e.code === "rate") { sentCalls[kind] = Date.now(); toast(e.message, "info"); replaceTop(serviceView); }
      else toast(e.code === "network" ? t("networkError") : e.message, "error");
    }
  }

  // ================================================================ dock (cart bar + tracker)
  function refreshDock() {
    clear(dock);
    if (!R.available) return;
    const inner = h("div.dock-inner");
    const active = tracked.map((x) => orders[x.token]).filter((o) => o && ["new", "preparing", "ready"].includes(o.status));
    if (active.length) {
      const o = active[0];
      inner.append(h("button.trackpill" + (o.status === "ready" ? ".ready" : ""), { onclick: () => openSheet(ordersView) },
        h("span.pulse"), t("orderNumber", { n: o.number }) + " · " + t("st_" + o.status),
        active.length > 1 ? h("span.badge", "+" + (active.length - 1)) : null));
    }
    const row = h("div.dock-row");
    if (T && T.active) row.append(h("button.svc-btn", { "aria-label": t("services"), onclick: () => openSheet(serviceView) }, icon("bell")));
    const n = cartCount();
    if (n && canOrder()) {
      row.append(h("button.cartbar", { onclick: () => openSheet(cartView) },
        h("span.count", String(n)), h("span.label", t("viewOrder")), h("span.total", money(totals(cartSubtotal()).total))));
    } else if (tracked.length && T) {
      row.append(h("button.cartbar", { style: { background: "var(--text)", color: "var(--bg)" }, onclick: () => openSheet(ordersView) },
        h("span.count", icon("receipt", "icon")), h("span.label", t("myOrders")), h("span.total", "")));
    }
    if (row.childNodes.length) inner.append(row);
    dock.append(inner);
  }

  // ================================================================ polling
  let pollTimer = null;
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOrders, ms);
  }

  async function pollOrders() {
    if (!tracked.length) return;
    if (document.hidden) return schedulePoll(15000);
    try {
      const res = await api.get("/api/p/orders?tokens=" + tracked.map((x) => x.token).join(","));
      const alive = new Set();
      for (const o of res.orders) {
        const prev = orders[o.token];
        orders[o.token] = o;
        alive.add(o.token);
        if (prev && prev.status !== o.status) {
          if (o.status === "ready") { toast(t("readyMsg", { n: o.number }), "ok", { duration: 6000 }); if (navigator.vibrate) navigator.vibrate([80, 60, 80, 60, 160]); }
          if (o.status === "cancelled") toast(t("cancelledMsg", { n: o.number }) + (o.cancel_reason ? " — " + o.cancel_reason : ""), "error", { duration: 7000 });
        }
      }
      if (alive.size !== tracked.length) { tracked = tracked.filter((x) => alive.has(x.token)); saveTracked(); }
      refreshDock();
      // live-update any open tracking view
      $$(".live-track, .live-list").forEach((box) => {
        if (box.classList.contains("live-track")) {
          const o = orders[box.dataset.token];
          if (o) mount(box, trackCard(o));
        } else {
          mount(box, tracked.map((x) => orders[x.token]).filter(Boolean).map(trackCard));
        }
      });
      const anyActive = Object.values(orders).some((o) => ["new", "preparing", "ready"].includes(o.status));
      schedulePoll(anyActive ? 5000 : 30000);
    } catch (e) {
      schedulePoll(10000);
    }
  }

  async function refreshMenu() {
    if (!T) return;
    try {
      const res = await api.get("/api/p/menu/" + encodeURIComponent(T.token));
      const wasOpen = canOrder();
      R = Object.assign(R, res.restaurant);
      MENU = res.menu;
      indexMenu();
      if (wasOpen !== canOrder() || !R.available) { render(); return; }
      const y = window.scrollY;
      if (tabsEl && tabsEl.childElementCount !== MENU.length) { render(); window.scrollTo(0, y); return; }
      renderSections();
      observe();
      window.scrollTo(0, y);
      refreshDock();
    } catch (_) { /* keep the current menu */ }
  }

  // ================================================================ boot
  window.addEventListener("offline", () => { if (!$(".offline")) document.body.append(h("div.offline", t("offline"))); });
  window.addEventListener("online", () => { $(".offline")?.remove(); refreshMenu(); schedulePoll(500); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshMenu(); if (tracked.length) schedulePoll(300); }
  });
  setInterval(() => { if (!document.hidden) refreshMenu(); }, 90 * 1000);

  // Drop cart lines that point at items that vanished while the phone was away.
  cart = cart.filter((l) => l && items.has(l.item_id) && l.qty > 0);
  saveCart();
  render();
  if (tracked.length) pollOrders();
})();
