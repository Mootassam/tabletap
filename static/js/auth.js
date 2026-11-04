/* Login and first-run setup forms. */
(function () {
  "use strict";
  const { $, api, readBoot, fieldError, clearErrors, withBusy } = TT;
  const boot = readBoot();
  TT.setCsrf(boot.csrf);
  const form = $(boot.mode === "setup" ? "#setup-form" : "#login-form");
  const errBox = $("#form-error");

  function showError(e) {
    if (e.field && fieldError(form, e.field, e.message)) return;
    errBox.textContent = e.message;
    errBox.hidden = false;
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    clearErrors(form);
    errBox.hidden = true;
    const data = Object.fromEntries(new FormData(form).entries());
    if (boot.mode === "setup") data.demo = !!form.querySelector('[name="demo"]').checked;
    else data.next = new URLSearchParams(location.search).get("next") || "";
    const btn = form.querySelector('button[type="submit"]');
    withBusy(btn, async () => {
      try {
        const res = await api.post(boot.mode === "setup" ? "/api/setup" : "/api/auth/login", data, { noAuthRedirect: true });
        location.href = res.redirect || "/";
      } catch (e) {
        if (e.code === "csrf") { location.reload(); return; }
        showError(e);
      }
    });
  });
})();