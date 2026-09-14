/*
 * Homepage only. Plays the hero verdict panel's one motion moment when it is
 * actually on screen: the verdicts settle once the criteria list is in view,
 * and the quoted 14:31 line is struck only once that line itself is fully
 * visible (on phones it sits below the first screen), still after the
 * verdicts have settled. Without this script, or with reduced motion, the
 * panel simply shows its final state.
 */
(function () {
  var panel = document.querySelector('.hp-hero .hp-panel');
  if (!panel || !('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var list = panel.querySelector('.hp-criteria');
  var scan = panel.querySelector('.hp-scan');
  var hit = panel.querySelector('.hp-line--hit');
  var STRIKE_AFTER_MS = 1450; // the last verdict finishes settling around here
  var playedAt = null;

  // Created first, so its callback runs before the strike observer's when
  // both targets are already on screen at load.
  var playObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      if (scan && list) scan.style.setProperty('--hp-scan-distance', list.offsetHeight + 'px');
      panel.classList.add('hp-play');
      playedAt = performance.now();
      playObserver.disconnect();
    });
  }, { threshold: 0.4 });
  playObserver.observe(list || panel);

  if (!hit) return;
  var strikeObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var elapsed = playedAt === null ? 0 : performance.now() - playedAt;
      hit.style.animationDelay = Math.max(150, STRIKE_AFTER_MS - elapsed) + 'ms';
      hit.classList.add('hp-strike');
      strikeObserver.disconnect();
    });
  }, { threshold: 1 });
  strikeObserver.observe(hit);
})();
