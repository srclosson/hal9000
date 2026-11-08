// Kept dependency-free so privacy rules can be tested without a browser or the Faro SDK.
const pages = new Set(['/', '/index.html', '/monitor', '/monitor.html', '/eye', '/eye.html', '/settings', '/settings.html', '/dashboard', '/dashboard.html']);
export function pageName(path) { return pages.has(path) ? path : '/:other'; }
export function browserUrl(value) {
  try {
    const u = new URL(value, 'https://hal.invalid');
    const path = pages.has(u.pathname) ? u.pathname : u.pathname.startsWith('/api/') ? '/api/:resource'
      : /^\/[\w/-]+\.(?:js|css|svg|png|webmanifest)$/.test(u.pathname) ? u.pathname : '/:resource';
    return `${u.origin}${path}`;
  } catch { return '[redacted URL]'; }
}
export function scrubItem(item) {
  // Faro must not capture DOM text, identities, chat content, auth URLs, or arbitrary console arguments.
  const scrub = (value, key = '') => {
    if (/^(?:user|email|username|text|innerHTML|outerHTML|title|selector|element|target|authorization|cookie|body|requestBody|responseBody)$/i.test(key)) return undefined;
    if (Array.isArray(value)) return value.map(v => scrub(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => {
      const clean = scrub(v, k); return clean === undefined ? [] : [[k, clean]];
    }));
    if (typeof value !== 'string') return value;
    if (/url|uri|href|filename|referrer/i.test(key)) return browserUrl(value);
    if (/^(?:message|value)$/i.test(key)) return '[frontend error; see type and stack frames]';
    return value.replace(/https?:\/\/[^\s"'<>]+/g, browserUrl)
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted credentials]');
  };
  return scrub(item);
}
