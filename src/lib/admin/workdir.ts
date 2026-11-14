import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fresh temp folder for one job step (steps run in separate invocations and share no disk). */
export const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tour-"));
export const removeWorkdir = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
