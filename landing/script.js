(function () {
  var toggle = document.querySelector('.nav-toggle');
  var drawer = document.getElementById('mobile-drawer');
  if (!toggle || !drawer) return;

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    drawer.classList.toggle('is-open', open);
    document.body.classList.toggle('no-scroll', open);
  }

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
  mq.addEventListener('change', function (e) {
    if (e.matches) setOpen(false);
  });
})();
