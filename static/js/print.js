/* Print pages: a Print button, and auto-print for kitchen tickets opened in a popup. */
(function () {
  var btn = document.getElementById("print-btn");
  if (btn) btn.addEventListener("click", function () { window.print(); });
  if (window.opener && /\/print\/order\//.test(location.pathname)) {
    window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 250); });
  }
})();