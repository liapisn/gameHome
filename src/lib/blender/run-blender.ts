/**
 * Run a Blender Python script headless: `blender -b --factory-startup -P <script> -- <jobFile>`.
 *
 * By default Blender runs on a boxd machine (src/lib/boxd/runner.ts), never on this computer.
 * BLENDER_RUNNER=local runs a local Blender instead (BLENDER_PATH overrides the per-platform
 * default), one at a time, and only for the fixed scripts in blender/. The major version is
 * pinned: the bpy API drifts between majors, and the scripts are written against 5.x.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { boxd, boxdBlenderVersion, runOnMachine, withMachine } from "@/lib/boxd/runner";

export const blenderRunner = (): "boxd" | "local" => (process.env.BLENDER_RUNNER === "local" ? "local" : "boxd");
/** Scripts that execute model-written code: boxd only, on a machine that is deleted afterwards. */
const UNTRUSTED = new Set(["run_object.py"]);

const DEFAULTS: Record<string, string> = {
  darwin: "/Applications/Blender.app/Contents/MacOS/Blender",
  win32: "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe",
  linux: "blender",
};
export const BLENDER_MAJOR = 5;

export function blenderPath(): string {
  const p = process.env.BLENDER_PATH ?? DEFAULTS[process.platform] ?? "blender";
  if (p.includes("/") || p.includes("\\")) {
    if (!fs.existsSync(p)) throw new Error(`Blender not found at ${p}; set BLENDER_PATH`);
  }
  return p;
}

/** "5.3.0 on boxd" or "5.3.0 (local)". */
export async function blenderInfo(): Promise<string> {
  return blenderRunner() === "boxd" ? `${await boxdBlenderVersion()} on boxd` : `${blenderVersion()} (local)`;
}

export function blenderVersion(bin = blenderPath()): string {
  const out = execFileSync(bin, ["--version"], { encoding: "utf8" });
  const m = out.match(/Blender (\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Couldn't read the Blender version from: ${out.slice(0, 200)}`);
  if (Number(m[1]) !== BLENDER_MAJOR) throw new Error(`Blender ${m[0]} found; the scripts need ${BLENDER_MAJOR}.x (set BLENDER_PATH)`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * `args` is `[jobFile]`. `marker`: the line the script prints when it finished (Blender exits 0
 * even when the script raised).
 */
export function runBlender(script: string, args: string[], log?: (line: string) => void, marker = "BUILD_SCENE_OK"): Promise<string> {
  const untrusted = UNTRUSTED.has(path.basename(script));
  if (blenderRunner() === "boxd") {
    if (args.length !== 1) throw new Error("runBlender on boxd takes exactly one argument: the job file");
    if (!untrusted) return withMachine((m) => runOnMachine(m, script, args[0], marker, log));
    // Model-written code: no internet (files travel through the SDK), 5 minutes at most, and the
    // machine is deleted afterwards.
    return withMachine(
      async (m) => {
        await boxd().machines.setEgressAllow(m.id, ["none"]);
        return runOnMachine(m, script, args[0], marker, log, { timeoutMs: 5 * 60_000 });
      },
      { discard: true },
    );
  }
  if (untrusted) throw new Error(`${path.basename(script)} runs model-written code: boxd only (unset BLENDER_RUNNER=local)`);
  const run = localQueue.then(() => runLocal(script, args, log, marker));
  localQueue = run.catch(() => {});
  return run;
}

/** Local Blender runs one at a time: several Cycles renders at once exhaust the GPU (Metal "Command buffer not completed"). */
let localQueue: Promise<unknown> = Promise.resolve();

function runLocal(script: string, args: string[], log: ((line: string) => void) | undefined, marker: string): Promise<string> {
  const bin = blenderPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-b", "--factory-startup", "-P", script, "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      if (log) for (const line of s.split("\n")) if (/Error|Traceback|_OK|Saved:/.test(line)) log(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      // Blender exits 0 even when the Python script raises; look for the script's own success marker.
      if (code === 0 && out.includes(marker)) resolve(out);
      else reject(new Error(`Blender failed (exit ${code}):\n${out.split("\n").slice(-30).join("\n")}`));
    });
  });
}
