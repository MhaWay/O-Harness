import { EventEmitter } from "node:events";
export * from "./sessions.ts";

export type DeviceKind = "local" | "remote" | "mobile";

export interface DeviceRuntime {
  id: string;
  name: string;
  kind: DeviceKind;
  status: "connected" | "offline";
  capabilities: string[];
  conn?: unknown; // ws connection for remote devices
  localHandler?: (method: string, params: any) => unknown | Promise<unknown>;
  meta?: Record<string, unknown>;
  connectedAt: number;
  lastSeen: number;
}

export type Handler = (params: any, ctx: { deviceId?: string }) => unknown | Promise<unknown>;

export class Bus extends EventEmitter {}

export function publicDevice(d: DeviceRuntime) {
  const { conn, localHandler, ...rest } = d;
  return rest;
}

export class Registry {
  #devices = new Map<string, DeviceRuntime>();
  register(dev: DeviceRuntime) { this.#devices.set(dev.id, dev); return dev; }
  get(id: string) { return this.#devices.get(id); }
  remove(id: string) { return this.#devices.delete(id); }
  update(id: string, patch: Partial<DeviceRuntime>) { const dev = this.#devices.get(id); if (dev) Object.assign(dev, patch); return dev; }
  all() { return [...this.#devices.values()]; }
  listPublic() { return this.all().map(publicDevice); }
}

export class RpcRouter {
  #handlers = new Map<string, Handler>();
  set(method: string, h: Handler) { this.#handlers.set(method, h); }
  has(method: string) { return this.#handlers.has(method); }
  methods() { return [...this.#handlers.keys()]; }
  async call(method: string, params: unknown): Promise<unknown> {
    const h = this.#handlers.get(method);
    if (!h) throw new Error("unknown method: " + String(method));
    return await h(params ?? {}, {});
  }
}

export interface GatewayApi {
  bus: Bus;
  registerRpc(method: string, handler: Handler): void;
  registerDevice(device: Partial<DeviceRuntime> & Pick<DeviceRuntime, "name" | "kind">): DeviceRuntime;
  unregisterDevice(id: string): void;
  emitEvent(topic: string, data?: unknown): void;
  callDevice(deviceId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface OHarnessPlugin {
  name: string;
  setup(api: GatewayApi): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export class PluginHost {
  plugins: OHarnessPlugin[] = [];
  register(plugin: OHarnessPlugin) { this.plugins.push(plugin); }
  async setupAll(api: GatewayApi) { for (const p of this.plugins) await p.setup(api); }
  async teardownAll() { for (const p of this.plugins) await p.teardown?.(); }
}
