export const PROTOCOL_VERSION = 1;

export const Msg = {
  Hello: "hello",
  Welcome: "welcome",
  RpcReq: "rpc:req",
  RpcRes: "rpc:res",
  Event: "event",
} as const;

export const Methods = {
  DevicesList: "devices.list",
  DeviceInfo: "device.info",
  DeviceExec: "device.exec",
  DeviceFsRead: "device.fs.read",
  DeviceFsWrite: "device.fs.write",
  SessionsList: "sessions.list",
  SessionsCreate: "sessions.create",
  SessionsGet: "sessions.get",
  SessionsAppend: "sessions.append",
  SettingsGet: "settings.get",
  SettingsSave: "settings.save",
  ModelsFetch: "models.fetch",
  ModelsTest: "models.test",
  SelfUpdate: "self.update",
  MemoryAdd: "memory.add",
  MemorySearch: "memory.search",
  MemoryList: "memory.list",
} as const;

export type WireMsg = { type: string; id?: string; method?: string; params?: unknown; result?: unknown; error?: unknown; [k: string]: unknown };

export function encode(obj: unknown): string {
  return JSON.stringify(obj);
}

export function decode(raw: string): WireMsg | null {
  try {
    const v = JSON.parse(raw);
    if (typeof v === "object" && v !== null && typeof v.type === "string") return v as WireMsg;
    return null;
  } catch {
    return null;
  }
}
