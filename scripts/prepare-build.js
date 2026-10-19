// Runs on every Vercel deploy (npm "vercel-build"). Fills in the full web address used by the
// Facebook / Messenger share preview. Set SITE_URL in Vercel to use your own domain, e.g. https://tickets.kapampangancenter.org
const fs = require('fs');
const path = require('path');
try {
  const file = path.join(__dirname, '..', 'public', 'index.html');
  const host = process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  if (!host) { console.log('[build] no site address known, share preview keeps relative links'); process.exit(0); }
  const base = (/^https?:\/\//.test(host) ? host : 'https://' + host).replace(/\/$/, '');
  const html = fs.readFileSync(file, 'utf8').split('__SITE_URL__').join(base);
  fs.writeFileSync(file, html);
  console.log('[build] share preview address set to', base);
} catch (e) {
  console.warn('[build] skipped:', e.message);
}