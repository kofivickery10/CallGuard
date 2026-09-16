(function () {
  try {
    var s = localStorage.getItem('cg-theme');
    var d = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', d ? 'dark' : 'light');
  } catch (e) {}
})();
