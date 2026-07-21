/* =====================================================================
   VNGROW EXPRESS — Khung đo lường (Google Analytics 4 + Facebook Pixel)
   ---------------------------------------------------------------------
   CÁCH DÙNG:
   1. Điền ID vào 2 dòng GA4_ID / FB_PIXEL_ID bên dưới rồi deploy lại.
   2. Để trống thì script tự bỏ qua, KHÔNG gây lỗi trang.
   3. Gọi vgTrack("ten_su_kien", { key: value }) ở bất kỳ đâu để ghi sự kiện.
      Sự kiện sẽ đẩy đồng thời sang GA4 (gtag event) và FB Pixel (trackCustom).
   ===================================================================== */
(function () {
  var GA4_ID = "";       // vd: "G-XXXXXXXXXX"
  var FB_PIXEL_ID = "";  // vd: "1234567890123456"

  // ---- Google Analytics 4 ----
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  if (GA4_ID) {
    var g = document.createElement("script");
    g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + GA4_ID;
    document.head.appendChild(g);
    gtag("js", new Date());
    gtag("config", GA4_ID);
  }

  // ---- Facebook Pixel ----
  if (FB_PIXEL_ID) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    fbq("init", FB_PIXEL_ID);
    fbq("track", "PageView");
  }

  // ---- Helper hợp nhất: đẩy 1 sự kiện sang cả GA4 và FB Pixel ----
  window.vgTrack = function (event, params) {
    params = params || {};
    try { if (GA4_ID && window.gtag) gtag("event", event, params); } catch (e) {}
    try { if (FB_PIXEL_ID && window.fbq) fbq("trackCustom", event, params); } catch (e) {}
    // Luôn log ra console để kiểm tra kể cả khi chưa điền ID.
    try { if (window.console) console.debug("[vgTrack]", event, params); } catch (e) {}
  };
})();
