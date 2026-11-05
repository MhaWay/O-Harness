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
  SessionsDelete: "sessions.delete",
  SessionsRename: "sessions.rename",
  SessionsSearch: "sessions.search",
  SessionsExport: "sessions.export",
  SessionsPin: "sessions.pin",
  SettingsGet: "settings.get",
  SettingsSave: "settings.save",
  ModelsFetch: "models.fetch",
  ModelsTest: "models.test",
  SelfUpdate: "self.update",
  AgentsSpawn: "agents.spawn",
  AgentsList: "agents.list",
  AgentsGet: "agents.get",
  AgentsKill: "agents.kill",
  MemoryAdd: "memory.add",
  MemoryConsolidate: "memory.consolidate",
  MemoryForget: "memory.forget",
  PairingCreate: "pairing.create",
  PairingList: "pairing.list",
  PairingRevoke: "pairing.revoke",
  MemorySearch: "memory.search",
  MemoryList: "memory.list",
  DeviceToolsOffer: "device.tools.offer",
  DeviceToolsList: "device.tools.list",
  DeviceToolsCall: "device.tools.call",
  ToolsPending: "tools.pending",
  ToolsRespond: "tools.respond",
  GrantsList: "grants.list",
  GrantsRevoke: "grants.revoke",
  ChatSend: "chat.send",
  ChatAbort: "chat.abort",
  ChatRegenerate: "chat.regenerate",
  ChatHistory: "chat.history",
  ScheduleCreate: "schedule.create",
  ScheduleList: "schedule.list",
  ScheduleRemove: "schedule.remove",
  ScheduleRunNow: "schedule.runNow",
  ScheduleSetDisabled: "schedule.setDisabled",
  AuthInfo: "auth.info",
  AuthSetPassword: "auth.setPassword",
  AuthLogin: "auth.login",
  AuthLogout: "auth.logout",
  AuthSessionsList: "auth.sessions.list",
  AuthSessionsRevoke: "auth.sessions.revoke",
  AuthOAuthSet: "auth.oauth.set",
  AuthOAuthRemove: "auth.oauth.remove",
  AuthStartOAuth: "auth.oauth.start",
  AuthSetTokenLogin: "auth.setTokenLogin",
  LogsTail: "logs.tail",
  LogsStats: "logs.stats",
  LogsResolve: "logs.resolve",
  LogsAudit: "logs.audit",
  VoiceGet: "voice.get",
  VoiceSave: "voice.save",
  VoiceSpeak: "voice.speak",
  VoiceAsr: "voice.asr",
  VoiceProbe: "voice.probe",
  MonitorStatus: "monitor.status",
  MonitorCheck: "monitor.check",
  MonitorAdd: "monitor.add",
  MonitorRemove: "monitor.remove",
  MonitorEnable: "monitor.enable",
  CacheStats: "cache.stats",
  CacheClear: "cache.clear",
  AlertList: "alerts.list",
  AlertAck: "alerts.ack",
  BackupRun: "backup.run",
  BackupList: "backup.list",
  BackupRestore: "backup.restore",
  DoctorRun: "doctor.run",
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
