/**
 * Tiny time-boxed, single-flight cache (final audit M3). The keyless universe
 * explorer path fanned out to the database (three queries plus venue lookups)
 * on every call while the payload is identical for every caller: now one load
 * per key per TTL, shared by everyone asking in the meantime (including while
 * it is still in flight). A failed load is not cached, so the next caller
 * retries. Keys must come from a bounded set (universe names, registry
 * symbols): entries are never evicted, only replaced.
 *
 * Pure: no env, no network; offline tested.
 */
export class TtlSingleFlight<K, V> {
  private entries = new Map<K, { at: number; value: Promise<V> }>();

  constructor(
    readonly ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
