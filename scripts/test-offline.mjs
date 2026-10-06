#!/usr/bin/env node
// Runs every test that needs no keys, no database and no network.
// Sets throwaway placeholder values for the three variables the shared clients
// need in order to be constructed (nothing is ever sent to them), so a fresh
// clone works right after `npm install`, with or without a .env file.
import { spawnSync } from 'node:child_process';

const placeholders = {
  SUPABASE_URL: 'https://offline.invalid',
  SUPABASE_SERVICE_KEY: 'offline-placeholder',
  VOYAGE_KEY: 'offline-placeholder',
};
const env = { ...process.env, SYNTHETICK_OFFLINE: '1' };
for (const [k, v] of Object.entries(placeholders)) {
  // A real .env is never loaded here on purpose: these tests must not touch real services.
  env[k] = v;
}
delete env.OPENROUTER_API_KEY;

const suites = [
  'runtime/test-regression.ts',
  'runtime/test-requirements.ts',
  'runtime/test-security.ts',
  'runtime/test-finreq-offline.ts',
  'runtime/test-parsing-offline.ts',
  'runtime/test-hardening-offline.ts',
  // Final security round: budgets, liveness, sessions, sealed X state, charge
  // first, capped refunds, HTTP limits, bot guards, SQL and CI hardening.
  'runtime/test-security-fixes-offline.ts',
  // Data display policy (DISPLAY_FMP_DATA, DISPLAY_SACRA_DATA,
  // API_RELAY_MARKET_DATA): every flag x channel x vendor, the run payload end
  // to end, prompt hygiene, universe payload, self-hosted pdf.js, frontend fixes.
  'runtime/test-display-policy-offline.ts',
  'runtime/test-proxy-and-hygiene-offline.ts',
  // sail-agent: runs on its own sources only (no viem/Sailor imports), so it
  // needs no install inside sail-agent/.
  'sail-agent/test/offline.test.ts',
];

let failed = 0;
for (const f of suites) {
  console.log(`\n=== ${f}`);
  const r = spawnSync('npx', ['tsx', f], { stdio: 'inherit', env });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${f} (exit ${r.status})`);
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : `\nAll ${suites.length} offline suites passed`);
process.exit(failed ? 1 : 0);
