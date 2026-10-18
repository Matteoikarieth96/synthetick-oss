// UI string catalogs (issue #17). en.json is the reference: every key exists
// there, and it.json must carry the same keys (runtime/test-i18n-offline.ts).
// Values are plain text, never HTML; {name} placeholders are filled by t().
import en from './en.json';
import it from './it.json';

export type Lang = 'en' | 'it';
export type MessageKey = keyof typeof en;

export const LANGS: readonly Lang[] = ['en', 'it'];
export const catalogs: Record<Lang, Record<string, string>> = { en, it };

/** Server-rendered text is always English; signal-desk.js swaps any node
 * carrying data-i18n to the saved language after hydration. */
export function t(key: MessageKey): string {
  return en[key];
}

/** The catalogs as a non-executable JSON data block for signal-desk.js, which
 * cannot import from app/. Escaping < keeps a value from closing the tag. */
export function catalogsJson(): string {
  return JSON.stringify(catalogs).replace(/</g, '\\u003c');
}
