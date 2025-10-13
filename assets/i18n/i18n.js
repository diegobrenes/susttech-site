<script>
// /assets/i18n/i18n.js
(function () {
  const DEFAULT_LANG = 'en';
  const LANGS = ['en','es','pt'];
  const forced = window.__FORCED_LANG__;

  function detectLang() {
    if (forced && LANGS.includes(forced)) return forced;
    const pathLang = location.pathname.split('/').filter(Boolean)[0];
    if (LANGS.includes(pathLang)) return pathLang;
    const saved = localStorage.getItem('lang');
    if (LANGS.includes(saved)) return saved;
    return DEFAULT_LANG;
  }

  async function loadDict(lang) {
    try {
      const res = await fetch(`/assets/i18n/${lang}.json`, { cache: 'no-store' });
      if (!res.ok) return {};
      return await res.json();
    } catch { return {}; }
  }

  function applyDict(dict) {
    // Text nodes
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    // Attributes: data-i18n-attr="placeholder:key, title:key2"
    document.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const pairs = el.getAttribute('data-i18n-attr').split(',').map(s => s.trim()).filter(Boolean);
      pairs.forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key && dict[key]) el.setAttribute(attr, dict[key]);
      });
    });
    // Meta + <title>
    if (dict['meta.title']) document.title = dict['meta.title'];
    const md = document.querySelector('meta[name="description"]');
    if (md && dict['meta.description']) md.setAttribute('content', dict['meta.description']);
  }

  async function load(lang) {
    const dict = await loadDict(lang);
    applyDict(dict);
    document.documentElement.setAttribute('lang', lang);
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = (lang === 'en') ? 'ES' : (lang === 'es' ? 'EN' : 'EN');
    localStorage.setItem('lang', lang);
    window.__CURRENT_LANG__ = lang;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#lang-toggle,[data-lang]');
    if (!btn) return;
    e.preventDefault();
    const current = window.__CURRENT_LANG__ || detectLang();
    const target = btn.getAttribute('data-lang') || (current === 'en' ? 'es' : 'en');
    if (target === 'en') location.href = '/';
    else location.href = `/${target}/`;
  });

  load(detectLang());
})();
</script>
