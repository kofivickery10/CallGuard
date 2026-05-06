(function () {
  // ─── Mobile drawer ────────────────────────────────────────────────────
  var toggle = document.querySelector('.nav-toggle');
  var drawer = document.getElementById('mobile-drawer');
  if (toggle && drawer) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      drawer.classList.toggle('is-open', open);
      document.body.classList.toggle('no-scroll', open);
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    drawer.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) setOpen(false);
    });
    var mq = window.matchMedia('(min-width: 769px)');
    mq.addEventListener('change', function (e) { if (e.matches) setOpen(false); });
  }

  // Bail out of all animations if the user prefers reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.reveal').forEach(function (el) {
      el.classList.add('is-visible');
    });
    return;
  }

  // ─── Scroll-reveal: fade + slide-up when elements enter the viewport ──
  if ('IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });

    // Auto-tag content elements as reveal targets if they aren't already
    var autoTargets = [
      '.section .lead',
      '.stat-card',
      '.problem-card',
      '.feature',
      '.usecase-card',
      '.step',
      '.faq-item',
      '.post-card',
      '.cta-card',
      '.compare-table',
      '.roi'
    ].join(',');

    document.querySelectorAll(autoTargets).forEach(function (el, i) {
      el.classList.add('reveal');
      // Stagger neighbouring elements so a row doesn't all snap together
      var delayClass = 'reveal-delay-' + ((i % 3) + 1);
      el.classList.add(delayClass);
      revealObserver.observe(el);
    });

    document.querySelectorAll('.reveal:not(.is-visible)').forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    // No IO support: just show everything
    document.querySelectorAll('.reveal').forEach(function (el) {
      el.classList.add('is-visible');
    });
  }

  // ─── Stat count-up: animate stat-num text from 0 to its value ─────────
  if ('IntersectionObserver' in window) {
    var parseStat = function (raw) {
      // Returns { prefix, end, suffix } so e.g. "5-10%" stays as is,
      // "100%" animates to 100, "90 min" animates to 90.
      var m = raw.trim().match(/^([^0-9]*)(\d+(?:\.\d+)?)(.*)$/);
      if (!m) return null;
      var n = parseFloat(m[2]);
      // Avoid animating ranges like "5-10%"
      if (raw.indexOf('-') >= 0) return null;
      return { prefix: m[1], end: n, suffix: m[3], decimals: (m[2].indexOf('.') >= 0 ? 1 : 0) };
    };

    var animateStat = function (el) {
      var raw = el.dataset.statRaw || el.textContent;
      el.dataset.statRaw = raw;
      var parsed = parseStat(raw);
      if (!parsed) return;
      var start = performance.now();
      var duration = 1100;
      var ease = function (t) { return 1 - Math.pow(1 - t, 3); };
      var step = function (now) {
        var t = Math.min(1, (now - start) / duration);
        var v = parsed.end * ease(t);
        el.textContent = parsed.prefix + v.toFixed(parsed.decimals) + parsed.suffix;
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = raw;
      };
      requestAnimationFrame(step);
    };

    var statObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateStat(entry.target);
          statObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    document.querySelectorAll('.stat-num').forEach(function (el) {
      statObserver.observe(el);
    });
  }
})();
