/*
 * CallGuard AI — consent-gated Google Analytics 4.
 *
 * GA is NOT loaded and NO cookies are set until the visitor accepts via the
 * banner. Choice is stored in localStorage and can be changed any time via the
 * "Cookie preferences" link injected into the footer. Google Consent Mode v2 is
 * set to "denied" by default and updated to "granted" only on acceptance.
 */
(function () {
  'use strict';

  var GA_ID = 'G-R7J6QXQPLM';
  var KEY = 'cg_analytics_consent'; // 'granted' | 'denied'

  // --- Consent Mode v2: deny everything non-essential by default ---
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
  });

  var gaLoaded = false;
  function loadGA() {
    if (gaLoaded || !GA_ID || GA_ID.indexOf('G-') !== 0) return;
    gaLoaded = true;
    gtag('consent', 'update', { analytics_storage: 'granted' });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_ID, { anonymize_ip: true });
  }

  function store(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ }
  }
  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // --- Banner ---
  function injectStyles() {
    if (document.getElementById('cg-cc-style')) return;
    var css =
      '.cg-cc{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;' +
      'width:calc(100% - 32px);max-width:680px;background:#1a2b22;color:#fff;border-radius:14px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.25);padding:18px 20px;font-family:Inter,system-ui,sans-serif;' +
      'display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px}' +
      '.cg-cc p{margin:0;font-size:13.5px;line-height:1.5;color:#d7e0db;flex:1 1 320px}' +
      '.cg-cc a{color:#6cc18d;text-decoration:underline}' +
      '.cg-cc-actions{display:flex;gap:10px;flex:0 0 auto;margin-left:auto}' +
      '.cg-cc button{font:inherit;font-size:13.5px;font-weight:600;border:0;border-radius:8px;' +
      'padding:9px 16px;cursor:pointer}' +
      '.cg-cc-accept{background:#4a9e6e;color:#fff}.cg-cc-accept:hover{background:#3f8a5f}' +
      '.cg-cc-decline{background:transparent;color:#d7e0db;border:1px solid #3a4d43}' +
      '.cg-cc-decline:hover{background:#243a30}' +
      '.cg-cookie-prefs{cursor:pointer}' +
      '@media(max-width:540px){.cg-cc-actions{margin-left:0;width:100%}.cg-cc button{flex:1}}';
    var st = document.createElement('style');
    st.id = 'cg-cc-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function removeBanner() {
    var el = document.getElementById('cg-cc');
    if (el) el.parentNode.removeChild(el);
  }

  function showBanner() {
    injectStyles();
    removeBanner();
    var bar = document.createElement('div');
    bar.id = 'cg-cc';
    bar.className = 'cg-cc';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML =
      '<p>We use Google Analytics to understand how visitors use this site. ' +
      'Analytics cookies are only set if you accept. See our ' +
      '<a href="/privacy#cookies">cookie policy</a>.</p>' +
      '<div class="cg-cc-actions">' +
      '<button type="button" class="cg-cc-decline">Decline</button>' +
      '<button type="button" class="cg-cc-accept">Accept</button>' +
      '</div>';
    bar.querySelector('.cg-cc-accept').addEventListener('click', function () {
      store('granted'); loadGA(); removeBanner();
    });
    bar.querySelector('.cg-cc-decline').addEventListener('click', function () {
      store('denied'); removeBanner();
    });
    document.body.appendChild(bar);
  }

  // "Cookie preferences" link in every footer so consent is withdrawable.
  function addPrefsLinks() {
    var bars = document.querySelectorAll('.footer-bottom');
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].querySelector('.cg-cookie-prefs')) continue;
      var span = document.createElement('span');
      var a = document.createElement('a');
      a.href = '#';
      a.className = 'cg-cookie-prefs';
      a.textContent = 'Cookie preferences';
      a.addEventListener('click', function (e) { e.preventDefault(); showBanner(); });
      span.appendChild(a);
      bars[i].appendChild(span);
    }
  }

  function init() {
    addPrefsLinks();
    var choice = read();
    if (choice === 'granted') loadGA();
    else if (choice !== 'denied') showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
