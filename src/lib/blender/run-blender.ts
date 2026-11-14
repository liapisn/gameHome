/**
 * Run a Blender Python script headless: `blender -b --factory-startup -P <script> -- <args>`.
 * BLENDER_PATH overrides the per-platform default. The major version is pinned: the bpy API
 * drifts between majors, and the scripts in blender/ are written against 5.x.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";

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

export function blenderVersion(bin = blenderPath()): string {
  const out = execFileSync(bin, ["--version"], { encoding: "utf8" });
  const m = out.match(/Blender (\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Couldn't read the Blender version from: ${out.slice(0, 200)}`);
  if (Number(m[1]) !== BLENDER_MAJOR) throw new Error(`Blender ${m[0]} found; the scripts need ${BLENDER_MAJOR}.x (set BLENDER_PATH)`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function runBlender(script: string, args: string[], log?: (line: string) => void): Promise<string> {
  const bin = blenderPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-b", "--factory-startup", "-P", script, "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      if (log) for (const line of s.split("\n")) if (/Error|Traceback|BUILD_SCENE|Saved:/.test(line)) log(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      // Blender exits 0 even when the Python script raises; look for the script's own success marker.
      if (code === 0 && out.includes("BUILD_SCENE_OK")) resolve(out);
      else reject(new Error(`Blender failed (exit ${code}):\n${out.split("\n").slice(-30).join("\n")}`));
    });
  });
}
