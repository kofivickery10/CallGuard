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

  // ─── Theme switch (light / dark) ─────────────────────────────────────
  // The initial theme is set before paint by an inline <head> script; here we
  // just wire the nav button and keep following the OS until the visitor picks.
  var root = document.documentElement;
  var themeBtn = document.querySelector('.theme-switch');
  var readStored = function () {
    try { return localStorage.getItem('cg-theme'); } catch (e) { return null; }
  };
  var setTheme = function (t, persist) {
    root.setAttribute('data-theme', t);
    if (themeBtn) themeBtn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
    if (persist) { try { localStorage.setItem('cg-theme', t); } catch (e) {} }
  };
  setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
    });
  }
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!readStored()) setTheme(e.matches ? 'dark' : 'light', false);
    });
  } catch (e) {}

  // ─── Demo request modal ────────────────────────────────────────────────
  // Progressive enhancement: every mailto:hello@callguardai.co.uk link on the
  // site is intercepted and opens this modal instead. The mailto hrefs are
  // left untouched in the HTML, so with JS disabled (or if this fails) the
  // links still work exactly as before.
  var DEMO_MAILTO_PREFIX = 'mailto:hello@callguardai.co.uk';
  var DEMO_ENDPOINT = 'https://app.callguardai.co.uk/api/public/demo-requests';
  var DEMO_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var demoModal = null; // built lazily on first CTA click

  // Pull ?subject=... off a clicked mailto href so we know which CTA the
  // visitor used (e.g. "CallGuard AI — demo request", "Starter quote").
  var parseMailtoSubject = function (href) {
    if (!href) return '';
    var qIndex = href.indexOf('?');
    if (qIndex === -1) return '';
    var pairs = href.slice(qIndex + 1).split('&');
    for (var i = 0; i < pairs.length; i++) {
      var eq = pairs[i].indexOf('=');
      var key = eq === -1 ? pairs[i] : pairs[i].slice(0, eq);
      if (key === 'subject') {
        var raw = (eq === -1 ? '' : pairs[i].slice(eq + 1)).replace(/\+/g, ' ');
        try { return decodeURIComponent(raw); } catch (e) { return raw; }
      }
    }
    return '';
  };

  var getDemoFocusable = function () {
    var nodes = demoModal.dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  };

  var onDemoModalKeydown = function (e) {
    if (!demoModal || !demoModal.overlay.classList.contains('is-open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDemoModal();
      return;
    }
    if (e.key !== 'Tab') return;
    var focusable = getDemoFocusable();
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !demoModal.dialog.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last || !demoModal.dialog.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  var setDemoFieldError = function (el, errorId, message) {
    var errorEl = demoModal.body.querySelector('#' + errorId);
    if (message) {
      el.setAttribute('aria-invalid', 'true');
      if (errorEl) { errorEl.textContent = message; errorEl.classList.add('is-visible'); }
    } else {
      el.removeAttribute('aria-invalid');
      if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('is-visible'); }
    }
  };

  var showDemoStatus = function (message, isError) {
    var statusEl = demoModal.body.querySelector('#demoFormStatus');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = isError ? 'form-status is-error' : 'form-status';
  };

  var setDemoSubmitting = function (form, isSubmitting) {
    var btn = form.querySelector('#demoSubmit');
    if (!btn) return;
    btn.disabled = isSubmitting;
    btn.textContent = isSubmitting ? 'Sending…' : 'Send request';
  };

  var trackDemoLead = function () {
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'generate_lead');
      }
    } catch (e) {}
  };

  var renderDemoNetworkFallback = function () {
    demoModal.body.innerHTML = [
      '<h2 class="modal-title" id="demoModalTitle" tabindex="-1">We couldn’t send that</h2>',
      '<p class="modal-sub">Sorry — something went wrong on our end. Please email us directly and a real person will pick it up.</p>',
      '<a class="btn btn-primary btn-lg" data-demo-skip="true" href="mailto:hello@callguardai.co.uk">Email hello@callguardai.co.uk</a>'
    ].join('');
    var heading = demoModal.body.querySelector('#demoModalTitle');
    if (heading) heading.focus();
  };

  var renderDemoSuccess = function () {
    demoModal.body.innerHTML = [
      '<div class="modal-success">',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
      '<h2 class="modal-title" id="demoModalTitle" tabindex="-1">Thanks — we’ll be in touch shortly</h2>',
      '<p>We’ve received your request and a member of the CallGuard AI team will reach out soon.</p>',
      '</div>'
    ].join('');
    var heading = demoModal.body.querySelector('#demoModalTitle');
    if (heading) heading.focus();
  };

  var onDemoFormSubmit = function (e) {
    e.preventDefault();
    var form = e.target;
    showDemoStatus('', false);

    var nameEl = form.querySelector('#demoName');
    var emailEl = form.querySelector('#demoEmail');
    var companyEl = form.querySelector('#demoCompany');
    var volumeEl = form.querySelector('#demoCallVolume');
    var messageEl = form.querySelector('#demoMessage');

    var name = nameEl.value.trim();
    var email = emailEl.value.trim();
    var message = messageEl.value.trim();

    var nameError = name ? '' : 'Please enter your name.';
    var emailError = !email ? 'Please enter your work email.' : (!DEMO_EMAIL_RE.test(email) ? 'Please enter a valid email address.' : '');
    var messageError = message.length > 2000 ? 'Message is too long (max 2000 characters).' : '';

    setDemoFieldError(nameEl, 'demoNameError', nameError);
    setDemoFieldError(emailEl, 'demoEmailError', emailError);
    setDemoFieldError(messageEl, 'demoMessageError', messageError);

    if (nameError || emailError || messageError) {
      (nameError ? nameEl : (emailError ? emailEl : messageEl)).focus();
      return;
    }

    var subject = form.getAttribute('data-subject') || '';
    var finalMessage = subject ? ('Re: ' + subject + (message ? ('\n\n' + message) : '')) : message;

    var payload = { name: name, email: email };
    var company = companyEl.value.trim();
    if (company) payload.company = company;
    if (volumeEl.value) payload.call_volume = volumeEl.value;
    if (finalMessage) payload.message = finalMessage;

    setDemoSubmitting(form, true);

    fetch(DEMO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (result) {
      setDemoSubmitting(form, false);
      if (result.ok) {
        trackDemoLead();
        renderDemoSuccess();
      } else {
        showDemoStatus((result.data && result.data.message) || 'Something went wrong. Please try again.', true);
      }
    }).catch(function () {
      setDemoSubmitting(form, false);
      renderDemoNetworkFallback();
    });
  };

  var renderDemoForm = function (subjectText) {
    demoModal.body.innerHTML = [
      '<h2 class="modal-title" id="demoModalTitle">Request a demo</h2>',
      '<p class="modal-sub" id="demoModalSub">Tell us a bit about your team and we’ll be in touch shortly.</p>',
      '<div class="form-status" id="demoFormStatus" role="status" aria-live="polite"></div>',
      '<form class="modal-form" id="demoForm" novalidate>',
      '<div class="form-field">',
      '<label class="form-label" for="demoName">Full name</label>',
      '<input class="form-input" type="text" id="demoName" name="name" autocomplete="name" aria-describedby="demoNameError">',
      '<p class="form-error" id="demoNameError"></p>',
      '</div>',
      '<div class="form-field">',
      '<label class="form-label" for="demoEmail">Work email</label>',
      '<input class="form-input" type="email" id="demoEmail" name="email" autocomplete="email" aria-describedby="demoEmailError">',
      '<p class="form-error" id="demoEmailError"></p>',
      '</div>',
      '<div class="form-field">',
      '<label class="form-label" for="demoCompany">Company <span class="form-optional">(optional)</span></label>',
      '<input class="form-input" type="text" id="demoCompany" name="company" autocomplete="organization">',
      '</div>',
      '<div class="form-field">',
      '<label class="form-label" for="demoCallVolume">Roughly how many calls a month? <span class="form-optional">(optional)</span></label>',
      '<select class="form-select" id="demoCallVolume" name="call_volume">',
      '<option value="">Prefer not to say</option>',
      '<option value="Under 500">Under 500</option>',
      '<option value="500–2,000">500–2,000</option>',
      '<option value="2,000–10,000">2,000–10,000</option>',
      '<option value="10,000+">10,000+</option>',
      '</select>',
      '</div>',
      '<div class="form-field">',
      '<label class="form-label" for="demoMessage">Message <span class="form-optional">(optional)</span></label>',
      '<textarea class="form-textarea" id="demoMessage" name="message" maxlength="2000" rows="3" aria-describedby="demoMessageError"></textarea>',
      '<p class="form-error" id="demoMessageError"></p>',
      '</div>',
      '<button type="submit" class="btn btn-primary btn-lg" id="demoSubmit">Send request</button>',
      '</form>'
    ].join('');

    var subEl = demoModal.body.querySelector('#demoModalSub');
    if (subEl && subjectText) {
      subEl.textContent = 'Re: ' + subjectText + '. Tell us a bit about your team and we’ll be in touch shortly.';
    }

    var form = demoModal.body.querySelector('#demoForm');
    form.setAttribute('data-subject', subjectText || '');
    form.addEventListener('submit', onDemoFormSubmit);
  };

  var buildDemoModal = function () {
    if (demoModal) return demoModal;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'demoModalOverlay';
    overlay.innerHTML = [
      '<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="demoModalTitle" id="demoModalDialog">',
      '<button type="button" class="modal-close" id="demoModalClose" aria-label="Close dialog">',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>',
      '</button>',
      '<div id="demoModalBody"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);

    demoModal = {
      overlay: overlay,
      dialog: overlay.querySelector('#demoModalDialog'),
      body: overlay.querySelector('#demoModalBody'),
      lastFocused: null
    };

    overlay.querySelector('#demoModalClose').addEventListener('click', closeDemoModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeDemoModal();
    });
    document.addEventListener('keydown', onDemoModalKeydown, true);

    return demoModal;
  };

  var openDemoModal = function (trigger, subjectText) {
    buildDemoModal();
    renderDemoForm(subjectText);
    demoModal.lastFocused = trigger || document.activeElement;
    demoModal.overlay.classList.add('is-open');
    document.body.classList.add('no-scroll');
    var firstField = demoModal.body.querySelector('#demoName');
    if (firstField) firstField.focus();
  };

  function closeDemoModal() {
    if (!demoModal || !demoModal.overlay.classList.contains('is-open')) return;
    demoModal.overlay.classList.remove('is-open');
    var drawerIsOpen = drawer && drawer.classList.contains('is-open');
    if (!drawerIsOpen) document.body.classList.remove('no-scroll');
    if (demoModal.lastFocused && typeof demoModal.lastFocused.focus === 'function') {
      demoModal.lastFocused.focus();
    }
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href^="' + DEMO_MAILTO_PREFIX + '"]') : null;
    if (!link || link.getAttribute('data-demo-skip') === 'true') return;
    e.preventDefault();
    openDemoModal(link, parseMailtoSubject(link.getAttribute('href')));
  });

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
