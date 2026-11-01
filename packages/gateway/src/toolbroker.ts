// Tool broker: devices (e.g. a phone) offer tools; the gateway enforces explicit authorization.
// Uncalled tools raise a pending approval ("tools.ask"); standing grants skip the prompt.
import { randomUUID } from "node:crypto";
import { GrantsStore } from "@o-harness/core";

export interface OfferedTool { name: string; description?: string; parameters?: Record<string, unknown> }
export interface ToolAsk { id: string; deviceId: string; tool: string; args: unknown; requester: string; createdAt: number }

interface Ask { id: string; deviceId: string; tool: string; args: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout; ask: ToolAsk }

export class ToolBroker {
  #tools = new Map<string, OfferedTool[]>();
  #asks = new Map<string, Ask>();
  #grants: GrantsStore;
  #invoke: (deviceId: string, tool: string, args: unknown) => Promise<unknown>;
  #broadcast: (topic: string, data: unknown) => void;
  constructor(grants: GrantsStore, invoke: (deviceId: string, tool: string, args: unknown) => Promise<unknown>, broadcast: (topic: string, data: unknown) => void) {
    this.#grants = grants; this.#invoke = invoke; this.#broadcast = broadcast;
  }

  offer(deviceId: string, tools: OfferedTool[]) {
    this.#tools.set(deviceId, tools);
    this.#broadcast("device.tools", { deviceId, tools });
  }
  forget(deviceId: string) { this.#tools.delete(deviceId); }
  list(deviceId?: string) {
    const out: Record<string, OfferedTool[]> = {};
    for (const [dev, tools] of this.#tools) if (!deviceId || dev === deviceId) out[dev] = tools;
    return out;
  }
  has(deviceId: string, tool: string) { return (this.#tools.get(deviceId) ?? []).some((t) => t.name === tool); }
  pending(): ToolAsk[] { return [...this.#asks.values()].map((a) => a.ask); }
  grantsFor(deviceId?: string) { return this.#grants.list(deviceId); }
  revoke(deviceId: string, tool: string) { return this.#grants.revoke(deviceId, tool); }

  async call(deviceId: string, tool: string, args: unknown, requester = "cli", timeoutMs = 300_000): Promise<unknown> {
    if (!this.has(deviceId, tool)) throw new Error("device " + deviceId + " offers no tool '" + tool + "'");
    if (this.#grants.check(deviceId, tool)) {
      this.#grants.touch(deviceId, tool);
      return await this.#invoke(deviceId, tool, args);
    }
    return await new Promise((resolve, reject) => {
      const id = randomUUID().slice(0, 8);
      const ask: ToolAsk = { id, deviceId, tool, args, requester, createdAt: Date.now() };
      const timer = setTimeout(() => {
        this.#asks.delete(id);
        reject(new Error("tool approval timed out (" + timeoutMs + "ms): " + tool));
      }, timeoutMs);
      this.#asks.set(id, { id, deviceId, tool, args, resolve, reject, timer, ask });
      this.#broadcast("tools.ask", ask);
    });
  }

  respond(id: string, approved: boolean, remember: boolean, ctx: { admin?: boolean; deviceId?: string }): boolean {
    const a = this.#asks.get(id);
    if (!a) return false;
    if (!ctx.admin && ctx.deviceId !== a.deviceId) throw new Error("only the device owner or an admin can respond");
    this.#asks.delete(id);
    clearTimeout(a.timer);
    if (approved) {
      if (remember) this.#grants.grant(a.deviceId, a.tool);
      this.#invoke(a.deviceId, a.tool, a.args).then(a.resolve, a.reject);
    } else {
      a.reject(new Error("tool '" + a.tool + "' denied by device owner"));
    }
    return true;
  }
}
