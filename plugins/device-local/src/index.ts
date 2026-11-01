import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname, platform, arch } from "node:os";
import type { OHarnessPlugin, GatewayApi } from "@o-harness/core";

function runShell(command: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

const plugin = {
  name: "device-local",
  async setup(api: GatewayApi) {
    api.registerDevice({
      id: "local",
      name: hostname(),
      kind: "local",
      capabilities: ["exec", "fs.read", "fs.write", "os:" + platform() + "/" + arch()],
      meta: { platform: platform(), arch: arch(), hostname: hostname() },
      localHandler: async (method: string, params: any) => {
        if (method === "exec") {
          if (typeof params?.command !== "string") throw new Error("exec: command required");
          return await runShell(params.command, params.cwd);
        }
        if (method === "fs.read") return { content: await readFile(String(params?.path), "utf-8") };
        if (method === "fs.write") {
          await mkdir(dirname(String(params?.path)), { recursive: true });
          await writeFile(String(params.path), String(params.content));
          return { ok: true };
        }
        throw new Error("local device: unsupported method '" + method + "'");
      },
    });
  },
};

export default plugin;
