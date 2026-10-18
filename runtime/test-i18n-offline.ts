/**
 * Offline checks for the UI string catalogs (issue #17): en.json and it.json
 * carry the same keys and placeholders, every value follows the copy rules
 * (plain text, no em or en dashes), every key the UI names exists, and the
 * client lookup in public/signal-desk.js falls back to English safely.
 * No network, no database, no keys.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { catalogs, catalogsJson } from '../app/i18n/index.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`PASS — ${name}`);
  else {
    failures++;
    console.log(`FAIL — ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}
const { en, it } = catalogs;
const enKeys = Object.keys(en);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// ---- same keys, same placeholders ----------------------------------------------
{
  const missingInIt = enKeys.filter((k) => !Object.hasOwn(it, k));
  const extraInIt = Object.keys(it).filter((k) => !Object.hasOwn(en, k));
  check('it.json has every key of en.json', missingInIt.length === 0, missingInIt);
  check('it.json has no key that en.json lacks', extraInIt.length === 0, extraInIt);
  const badVars = enKeys.filter((k) => Object.hasOwn(it, k) && placeholders(en[k]!) !== placeholders(it[k]!));
  check('each key uses the same {placeholders} in both languages', badVars.length === 0, badVars);
}

// ---- copy rules on every value ---------------------------------------------------
for (const [lang, cat] of Object.entries(catalogs)) {
  const entries = Object.entries(cat);
  const notText = entries.filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
  check(`${lang}.json: every value is a non-empty string`, notText.length === 0, notText);
  const markup = entries.filter(([, v]) => /[<>]/.test(v)).map(([k]) => k);
  check(`${lang}.json: no < or > in any value (plain text, never HTML)`, markup.length === 0, markup);
  const dashes = entries.filter(([, v]) => /[—–]/.test(v)).map(([k]) => k);
  check(`${lang}.json: no em or en dashes`, dashes.length === 0, dashes);
}
check('the serialized data block cannot close its <script> tag', !catalogsJson().includes('<'));

// ---- every key the UI names exists -------------------------------------------------
{
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const pageKeys = [...page.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map((m) => m[1]!);
  const missing = pageKeys.filter((k) => !Object.hasOwn(en, k));
  check(`app/page.tsx: all ${pageKeys.length} data-i18n keys exist`, pageKeys.length > 0 && missing.length === 0, missing);

  const desk = readFileSync(new URL('../public/signal-desk.js', import.meta.url), 'utf8');
  const literal = [...desk.matchAll(/\bsdT\('([\w.]+)'/g)].map((m) => m[1]!);
  const counted = [...desk.matchAll(/\bsdTn\('([\w.]+)'/g)].flatMap((m) => [`${m[1]}.one`, `${m[1]}.other`]);
  const ternary = [...desk.matchAll(/\bsdT\([^()]*?\?\s*'(\w+\.[\w.]+)'\s*:\s*'(\w+\.[\w.]+)'/g)].flatMap((m) => [m[1]!, m[2]!]);
  // Keys built from a value: each family must cover every value the code passes.
  const families = [
    ...['thesis', 'progress', 'results'].flatMap((s) => [`section.${s}`, `section.${s}.info`]),
    ...['long', 'short', 'both'].map((v) => `review.direction.${v}`),
    ...['focused', 'diversified'].map((v) => `review.breadth.${v}`),
    ...['all', 'stock', 'crypto', 'etf', 'private', 'polymarket'].map((v) => `review.assets.${v}`),
    ...['global', 'us', 'eu', 'cn', 'it'].map((v) => `review.markets.${v}`),
    ...['all', 'low', 'medium', 'high'].map((v) => `review.cap.${v}`),
    ...['stock', 'crypto', 'etf', 'bond', 'private', 'polymarket'].map((v) => `label.asset.${v}`),
    ...['us', 'eu', 'cn', 'it', 'other', 'global'].map((v) => `label.region.${v}`),
    ...['rank', 'score', 'cap', 'move'].map((v) => `results.sort.${v}`),
    // Passed as tt(...) so the PDF report can use English, or via an sdTn() ternary.
    ...['long', 'short', 'both'].map((v) => `label.dir.${v}`),
    'label.asset.none',
    'label.region.none',
    ...['matched', 'shortMatched'].flatMap((v) => [`results.${v}.one`, `results.${v}.other`]),
  ];
  const deskKeys = [...new Set([...literal, ...counted, ...ternary, ...families])];
  const missingDesk = deskKeys.filter((k) => !Object.hasOwn(en, k));
  check(`public/signal-desk.js: all ${deskKeys.length} keys exist`, literal.length > 0 && missingDesk.length === 0, missingDesk);
}

// ---- the client lookup, run as the browser runs it -----------------------------------
// The i18n block at the top of signal-desk.js is evaluated in a sandbox with a
// stub document (holding the same JSON data block layout.tsx renders) and a
// stub localStorage returning the given saved language. Like the real page,
// the global scope already holds short names from Next's scripts (a global t
// is what broke the first version of this block), so the block must not
// redeclare them.
type Client = { lang: string; t: (k: string, v?: object) => string; tr: (l: string, k: string, v?: object) => string; tn: (k: string, n: number, v?: object) => string };
function client(saved: string | null, json = catalogsJson()): Client {
  const desk = readFileSync(new URL('../public/signal-desk.js', import.meta.url), 'utf8');
  const start = desk.indexOf('// ---- UI language');
  const end = desk.indexOf('\nconst feed =');
  const block = desk.slice(start, end);
  const ctx = vm.createContext({
    document: { getElementById: (id: string) => (id === 'sd-i18n' ? { textContent: json } : null), querySelectorAll: () => [] },
    localStorage: { getItem: () => saved },
  });
  vm.runInContext('var t = {}, e, n, r, o, i;', ctx);
  return vm.runInContext(`${block}\n;({ lang: uiLang, t: sdT, tr: sdTr, tn: sdTn })`, ctx) as Client;
}
check('the i18n block loads next to the short globals Next declares (no SyntaxError)', (() => { try { client(null); return true; } catch { return false; } })());
{
  check('saved "it" selects Italian', client('it').lang === 'it');
  check('nothing saved means English', client(null).lang === 'en');
  const odd = ['IT', 'fr', '__proto__', 'constructor', 'it ', '<script>'].filter((v) => client(v).lang !== 'en');
  check('any other saved value means English', odd.length === 0, odd);

  const c = client('it');
  check('Italian text comes from it.json', c.t('settings.language') === it['settings.language']);
  check('placeholders are filled', c.t('review.themes.editMore', { count: 4 }) === it['review.themes.editMore']!.replace('{count}', '4'));
  check('count-dependent keys pick .one and .other', c.tn('results.matched', 1) === it['results.matched.one']!.replace('{count}', '1') && c.tn('results.matched', 3) === it['results.matched.other']!.replace('{count}', '3'));
  check('an unknown placeholder name is left as is', c.tr('en', 'composer.mic.unavailable', { other: 'x' }) === en['composer.mic.unavailable']);
  check('placeholder vars never reach Object.prototype', c.tr('en', 'composer.mic.unavailable', {}) === en['composer.mic.unavailable']);
  const proto = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].filter((k) => c.t(k) !== k);
  check('prototype names are not keys: they fall back to the key itself', proto.length === 0, proto);
  check('an unknown key shows the key', c.t('no.such.key') === 'no.such.key');

  const partial = JSON.stringify({ en: { a: 'English A', b: 'English B' }, it: { a: 'Italiano A' } });
  const p = client('it', partial);
  check('a key missing from it.json falls back to English', p.t('a') === 'Italiano A' && p.t('b') === 'English B');
  check('a broken data block falls back to the keys, without throwing', client('it', '{not json').t('a') === 'a');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll i18n checks passed');
process.exit(failures ? 1 : 0);
