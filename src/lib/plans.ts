import "server-only";
import fs from "node:fs";
import path from "node:path";
import { demoPlan, type FloorPlan } from "@/lib/floorplan";

const PLANS_DIR = path.join(process.cwd(), "src/data/plans");

/**
 * Plans that may be published. Parsed plans built from third-party fixtures
 * stay dev-only until we have the rights to show them.
 */
const PUBLIC_PLAN_IDS = new Set([demoPlan.id]);

const isDev = process.env.NODE_ENV !== "production";

function parsedPlanIds(): string[] {
  if (!fs.existsSync(PLANS_DIR)) return [];
  return fs
    .readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".raw.json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function listPlanIds({ includePrivate = isDev } = {}): string[] {
  const ids = ["demo", ...parsedPlanIds()];
  return includePrivate ? ids : ids.filter((id) => id === "demo" || PUBLIC_PLAN_IDS.has(id));
}

export function getPlan(id: string): FloorPlan | null {
  if (id === "demo") return demoPlan;
  if (!listPlanIds().includes(id)) return null;
  return JSON.parse(fs.readFileSync(path.join(PLANS_DIR, `${id}.json`), "utf8")) as FloorPlan;
}
