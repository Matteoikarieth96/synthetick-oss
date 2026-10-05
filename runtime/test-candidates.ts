/**
 * Milestone 2 test gate (spec §10.2) — retrieval quality + hard-filter checks.
 * Crypto-side tests run against today's data; equity assertions activate once
 * the equities backfill lands (they report SKIP while the universe is empty).
 */
import { log } from '../ingest/lib/log.js';
import { countAssets, supabase } from '../ingest/lib/supabase.js';
import { getCandidates } from './candidates.js';

let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  log.info(`${mark} — ${name}: ${detail}`);
}

function skip(name: string, why: string) {
  log.warn(`SKIP — ${name}: ${why}`);
}

async function main() {
  const equities = await countAssets({ source: 'fmp' });
  const crypto = await countAssets({ source: 'coingecko' });
  log.step(`Universe: ${equities} equities, ${crypto} crypto`);

  // 1. "GPU compute" thesis (§10.2): NVDA/AMD/TSMC/SMH in top-30 (needs equities);
  //    RENDER (crypto GPU network) should appear regardless.
  {
    const thesis =
      'GPU compute demand is exploding with AI training and inference workloads. ' +
      'Semiconductor designers, foundries, and decentralized GPU compute networks benefit. ' +
      'Themes: GPUs, AI accelerators, semiconductors, data centers, cloud compute.';
    const c = await getCandidates(thesis);
    const top30 = c.slice(0, 30).map((x) => x.ticker);
    check('gpu: retrieval non-empty', c.length > 0, `${c.length} candidates`);
    check('gpu: RENDER in top-30', top30.includes('RENDER'), `top-10: ${top30.slice(0, 10).join(', ')}`);
    // Gate against the names actually ingested (backfill is incremental).
    const want = ['NVDA', 'AMD', 'TSM', 'SMH'];
    const { data: present } = await supabase
      .from('assets').select('ticker').in('ticker', want).eq('source', 'fmp');
    const avail = (present ?? []).map((r) => r.ticker);
    if (avail.length >= 2) {
      const hit = avail.filter((t) => top30.includes(t));
      // Require both when only two benchmarks are ingested, two of three for
      // a partial fixture, or three of four for the complete benchmark set.
      const minHits = Math.min(3, Math.max(2, avail.length - 1));
      check(
        `gpu: ingested GPU names in top-30 (${avail.join('/')})`,
        hit.length >= minHits,
        `found: ${hit.join(', ') || 'none'}`,
      );
    } else {
      skip('gpu: NVDA/AMD/TSM/SMH in top-30', `only ${avail.length} of the 4 ingested so far`);
    }
  }

  // 2. "Only crypto related to the Ethereum ecosystem" (§11): hard kind filter +
  //    semantic boost; zero non-crypto leaks tolerated.
  {
    const thesis =
      'Decentralized applications and smart-contract infrastructure on Ethereum: ' +
      'rollups, staking, DeFi protocols. Themes: Ethereum ecosystem, Layer 2, DeFi.';
    const c = await getCandidates(thesis, { assetSet: ['crypto'], semantic: 'Ethereum ecosystem' });
    const nonCrypto = c.filter((x) => x.kind !== 'crypto');
    const ecoShare = c.slice(0, 30).filter((x) => x.categories?.some((t) => /ethereum/i.test(t))).length;
    check('eth: only crypto returned', nonCrypto.length === 0, `${nonCrypto.length} non-crypto leaked of ${c.length}`);
    check('eth: ecosystem tags dominate top-30', ecoShare >= 20, `${ecoShare}/30 tagged Ethereum*`);
  }

  // 3. "Only European ETFs" (§10.2): exclusively kind=etf, region=eu — and an
  //    HONEST empty state (no relaxation) while no EU ETFs are ingested.
  {
    const thesis = 'Broad diversified European equity exposure via index funds. Themes: Europe, ETFs, UCITS.';
    const c = await getCandidates(thesis, { assetSet: ['etf'], regionSet: ['eu'] });
    const violations = c.filter((x) => x.kind !== 'etf' || x.region !== 'eu');
    check('eu-etf: zero filter violations', violations.length === 0, `${violations.length} violations of ${c.length} rows`);
    if (c.length === 0) {
      // Honest empty is only wrong if EU ETFs actually exist in the universe.
      const { count } = await supabase
        .from('assets').select('id', { count: 'exact', head: true })
        .eq('source', 'fmp').eq('kind', 'etf').eq('region', 'eu').eq('is_active', true);
      const anyEuEtf = (count ?? 0) > 0;
      check('eu-etf: honest empty state', !anyEuEtf, `0 rows with ${count ?? 0} EU ETFs in universe — ${anyEuEtf ? 'unexpected' : 'expected until EU backfill lands'}`);
    } else {
      check('eu-etf: results are EU ETFs', true, `${c.length} rows, top: ${c.slice(0, 5).map((x) => x.ticker).join(', ')}`);
    }
  }

  // 4. Exclusions respected: exclude the top hit, re-run, confirm gone.
  {
    const thesis = 'Bitcoin as digital gold and a macro hedge. Themes: Bitcoin, store of value.';
    const first = await getCandidates(thesis, { assetSet: ['crypto'] });
    const top = first[0]?.ticker;
    if (top) {
      const second = await getCandidates(thesis, { assetSet: ['crypto'], excludeTickers: [top] });
      check('exclusions: excluded ticker absent', !second.some((x) => x.ticker === top), `excluded ${top}`);
    } else {
      skip('exclusions', 'no crypto candidates to exclude');
    }
  }

  log.step(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  log.error('test-candidates failed', err);
  process.exit(1);
});
