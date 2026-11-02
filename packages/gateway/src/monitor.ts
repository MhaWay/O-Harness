import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "@o-harness/core";
import { join } from "node:path";
import WebSocket from "ws";

export interface ServiceCfg { id: string; name: string; kind: "models" | "http" | "ws"; url: string; enabled: boolean; failCount: number }
export interface ServiceStatus { id: string; name: string; kind: string; url: string; ok: boolean; latencyMs?: number; detail: string; checkedAt: number; consecutiveFails: number }
export interface Alert { id: string; serviceId: string; name: string; state: "firing" | "resolved"; at: number; detail: string; acked: boolean }

const FILE = "monitor.json";

/** Service liveness probing + alerting: 3 consecutive fails fire an alert, success after down resolves it. */
export class MonitorStore {
  dir: string;
  services: ServiceCfg[] = [];
  alerts: Alert[] = [];
  lastStatus: ServiceStatus[] = [];
  lastCheckAt = 0;
  #file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.#file = join(dir, FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(this.#file)) {
      try {
        const j = JSON.parse(readFileSync(this.#file, "utf8"));
        this.services = Array.isArray(j.services) ? j.services : [];
        this.alerts = Array.isArray(j.alerts) ? j.alerts.slice(0, 200) : [];
      } catch { /* start fresh */ }
    }
  }

  #save(): void {
    try { atomicWrite(this.#file, JSON.stringify({ services: this.services, alerts: this.alerts.slice(0, 200) })); } catch { /* never throws */ }
  }
  save(): void { this.#save(); }

  addService(name: string, kind: "models" | "http" | "ws", url: string): ServiceCfg {
    const id = Math.random().toString(36).slice(2, 10);
    const s: ServiceCfg = { id, name, kind, url, enabled: true, failCount: 0 };
    this.services.push(s); this.#save(); return s;
  }
  removeService(id: string): boolean {
    const before = this.services.length;
    this.services = this.services.filter((x) => x.id !== id);
    this.#save();
    return this.services.length !== before;
  }
  setEnabled(id: string, enabled: boolean): boolean {
    const s = this.services.find((x) => x.id === id);
    if (!s) return false;
    s.enabled = enabled; this.#save(); return true;
  }

  async #probeHttp(url: string): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      return { ok: res.ok, detail: "HTTP " + res.status, latencyMs: Date.now() - t0 };
    } catch (e) {
      clearTimeout(to);
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t0 };
    }
  }

  async #probeWs(url: string): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t0 = Date.now();
    return await new Promise((resolve) => {
      let done = false;
      const fin = (ok: boolean, detail: string) => { if (!done) { done = true; resolve({ ok, detail, latencyMs: Date.now() - t0 }) } };
      try {
        const ws = new WebSocket(url);
        const to = setTimeout(() => { try { ws.close() } catch { /* noop */ } fin(false, "timeout 5s") }, 5000);
        ws.on("open", () => { clearTimeout(to); try { ws.close() } catch { /* noop */ } fin(true, "ws ok") });
        ws.on("error", (e: Error) => { clearTimeout(to); fin(false, e.message) });
      } catch (e) {
        fin(false, e instanceof Error ? e.message : String(e));
      }
    });
  }

  async check(broadcast?: (topic: string, data: unknown) => void, logger?: { warn: (m: string, msg: string, meta?: Record<string, unknown>) => void }): Promise<ServiceStatus[]> {
    const out: ServiceStatus[] = [];
    for (const s of this.services) {
      if (!s.enabled) continue;
      let r: { ok: boolean; detail: string; latencyMs: number };
      if (s.kind === "ws") r = await this.#probeWs(s.url);
      else if (s.kind === "models") {
        const base = s.url.replace(/\/+$/, "");
        r = await this.#probeHttp(/\/v\d+$/.test(base) ? base + "/models" : base + "/v1/models");
      } else r = await this.#probeHttp(s.url);
      const prev = this.lastStatus.find((x) => x.id === s.id);
      if (r.ok) {
        if (prev && !prev.ok) this.#resolve(s, broadcast, logger);
        s.failCount = 0;
      } else {
        s.failCount = (prev ? prev.consecutiveFails : 0) + 1;
        if (!prev || prev.ok || s.failCount === 3) this.#fire(s, r, broadcast, logger);
      }
      out.push({ id: s.id, name: s.name, kind: s.kind, url: s.url, ok: r.ok, latencyMs: r.latencyMs, detail: r.detail, checkedAt: Date.now(), consecutiveFails: s.failCount });
    }
    this.lastStatus = out; this.lastCheckAt = Date.now();
    this.#save();
    if (broadcast) broadcast("monitor.changed", { checkedAt: Date.now(), down: out.filter((x) => !x.ok).length });
    return out;
  }

  #fire(s: ServiceCfg, r: { detail: string }, broadcast?: (topic: string, data: unknown) => void, logger?: { warn: (m: string, msg: string, meta?: Record<string, unknown>) => void }): void {
    const open = this.alerts.find((a) => a.serviceId === s.id && a.state === "firing");
    if (open) return;
    const alert: Alert = { id: Math.random().toString(36).slice(2, 10), serviceId: s.id, name: s.name, state: "firing", at: Date.now(), detail: r.detail, acked: false };
    this.alerts.unshift(alert);
    logger?.warn("monitor", "service down: " + s.name + " (" + r.detail + ")", { url: s.url });
    if (broadcast) broadcast("alert.fired", alert);
  }

  #resolve(s: ServiceCfg, broadcast?: (topic: string, data: unknown) => void, logger?: { warn: (m: string, msg: string, meta?: Record<string, unknown>) => void }): void {
    const open = this.alerts.find((a) => a.serviceId === s.id && a.state === "firing");
    if (open) { open.state = "resolved"; open.acked = true; }
    const rec: Alert = { id: Math.random().toString(36).slice(2, 10), serviceId: s.id, name: s.name, state: "resolved", at: Date.now(), detail: "back up", acked: true };
    this.alerts.unshift(rec);
    logger?.warn("monitor", "service back up: " + s.name);
    if (broadcast) broadcast("alert.resolved", rec);
  }

  ackAlert(id: string): boolean {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return false;
    a.acked = true; this.#save(); return true;
  }

  openAlerts(): Alert[] { return this.alerts.filter((a) => a.state === "firing"); }
}
