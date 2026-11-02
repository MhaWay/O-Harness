import { createHash } from "node:crypto";

/**
 * In-process model response cache. Caches only deterministic auxiliary calls
 * (consolidation, log analysis) keyed by (model, messages, effort, tools-hash).
 * Chat/minion loops are intentionally never served from cache.
 */
export interface CacheStats { hits: number; misses: number; entries: number; bytes: number; lastHitAt: number; hitRate: number }

interface Entry { value: unknown; expiresAt: number }

export class ModelCache {
  ttlMs: number;
  maxEntries: number;
  #map = new Map<string, Entry>();
  #hits = 0;
  #misses = 0;
  #lastHitAt = 0;

  constructor(ttlMs = 15 * 60 * 1000, maxEntries = 100) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  static key(opts: { model: string; messages: unknown[]; effort?: string; extra?: Record<string, unknown>; cacheBust?: string }): string {
    const blob = opts.model + "|" + (opts.effort ?? "") + "|" + JSON.stringify(opts.messages ?? []) + "|" + JSON.stringify(opts.extra ?? {}) + (opts.cacheBust ? "|" + opts.cacheBust : "");
    return createHash("sha256").update(blob).digest("hex").slice(0, 32);
  }

  get(key: string): { value: unknown } | null {
    const e = this.#map.get(key);
    if (!e || e.expiresAt < Date.now()) { if (e) this.#map.delete(key); this.#misses++; return null; }
    this.#hits++; this.#lastHitAt = Date.now();
    return { value: e.value };
  }

  set(key: string, value: unknown): void {
    if (this.#map.size >= this.maxEntries) {
      const first = this.#map.keys().next();
      if (!first.done) this.#map.delete(first.value);
    }
    this.#map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Fetch-or-cached wrapper: fn() only runs on miss. */
  async wrap<T>(opts: { model: string; messages: unknown[]; effort?: string; extra?: Record<string, unknown>; cacheBust?: string }, fn: () => Promise<T>): Promise<T> {
    const k = ModelCache.key(opts);
    const hit = this.get(k);
    if (hit) return hit.value as T;
    const v = await fn();
    this.set(k, v);
    return v;
  }

  clear(): number { const n = this.#map.size; this.#map.clear(); return n; }
  stats(): CacheStats {
    let bytes = 0;
    try { bytes = JSON.stringify([...this.#map.values()].map((x) => x.value)).length; } catch { /* big */ }
    const tot = this.#hits + this.#misses;
    return { hits: this.#hits, misses: this.#misses, entries: this.#map.size, bytes, lastHitAt: this.#lastHitAt, hitRate: tot ? this.#hits / tot : 0 };
  }
}