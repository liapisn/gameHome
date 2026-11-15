/**
 * House worker: every furnished room of a tour through its room worker, all at once, then one
 * house model and a final review. See docs/agent-tree-plan.md.
 */
import fs from "node:fs";
import path from "node:path";
import { buildDollhouseScene } from "@/lib/dollhouse-geometry";
import type { FloorPlan } from "@/lib/floorplan";
import { sceneToGlb } from "@/lib/glb";
import type { RoomScene } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";
import { critiqueHouse } from "./critic";
import { runRoomWorker } from "./room-worker";
import { blenderJob, cachedJson } from "./util";

export async function runHouseWorker(o: {
  tour: Tour;
  outRoot: string;
  log: (m: string) => void;
  rooms?: string[];
  /** Scenes and plans when they don't come from src/data (a tour downloaded from the app). */
  scenes?: RoomScene[];
  plans?: FloorPlan[];
  /** Folder of the scene builds' work dirs (<level>-<room>), when not exports/<tour>/. */
  sceneRoot?: string;
}) {
  const { tour, outRoot, log } = o;
  const startedAt = new Date().toISOString();
  // Furnished rooms: those with a scene (npm run build:scene, or the app's scenes.json).
  const rooms = (
    o.rooms ??
    (o.scenes
      ? o.scenes.filter((s) => s.items.some((i) => i.source === "photos")).map((s) => `${s.levelId}/${s.roomId}`)
      : fs.readdirSync(path.resolve("src/data/scenes", tour.id)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "").replace("-", "/")))
  ).sort();
  const planOf = (levelId: string) => {
    const level = tour.levels.find((l) => l.id === levelId)!;
    return o.plans?.find((p) => p.id === level.planId) ?? (JSON.parse(fs.readFileSync(path.resolve("src/data/plans", `${level.planId}.json`), "utf8")) as FloorPlan);
  };
  log(`house ${tour.id}: ${rooms.length} room(s): ${rooms.join(", ")}`);

  const runs = await Promise.all(
    rooms.map(async (key) => {
      const [levelId, roomId] = key.split("/");
      try {
        const scene = o.scenes?.find((s) => s.levelId === levelId && s.roomId === roomId);
        const r = await runRoomWorker({ tour, levelId, roomId, outRoot, log, scene, plan: o.plans ? planOf(levelId) : undefined, sceneDir: o.sceneRoot ? path.join(o.sceneRoot, `${levelId}-${roomId}`) : undefined });
        log(`room ${key}: ${r.summary}`);
        return { key, levelId, ...r, error: null as string | null };
      } catch (err) {
        log(`room ${key} FAILED: ${(err as Error).message}`);
        return { key, levelId, summary: "failed", roomGlb: null, report: null, error: (err as Error).message };
      }
    }),
  );

  // One house model: each floor's shell once, then every room's furniture.
  const built = runs.filter((r) => r.roomGlb && fs.existsSync(r.roomGlb));
  const levelIds = [...new Set(built.map((r) => r.levelId))];
  const levels = await Promise.all(
    levelIds.map(async (id) => {
      const level = tour.levels.find((l) => l.id === id)!;
      const plan = planOf(id);
      const shell = path.join(outRoot, `shell-${id}.glb`);
      if (!fs.existsSync(shell)) fs.writeFileSync(shell, await sceneToGlb(buildDollhouseScene({ ...plan, ceilingHeight: level.ceilingHeight ?? plan.ceilingHeight }, { ceilings: true })));
      return { id, shell, elevation: level.elevation, offset: level.offset };
    }),
  );
  const houseGlb = path.join(outRoot, "house.glb");
  if (built.length) {
    await blenderJob("join_house.py", path.join(outRoot, "join-job.json"), { levels, rooms: built.map((r) => ({ id: r.key, glb: r.roomGlb, level: r.levelId })), out: houseGlb });
  }

  // Final review: photos beside renders, per room.
  const reports = built.map((r) => JSON.parse(fs.readFileSync(r.report!, "utf8")) as { room: string; compare: string[]; models: { status: string }[]; standIns: unknown[] });
  const critique = reports.length
    ? await cachedJson(path.join(outRoot, `critique-${reports.map((r) => r.room).join("_").replace(/\//g, "-")}.json`), () =>
        critiqueHouse(reports.map((r) => ({ room: r.room, pairs: r.compare }))),
      )
    : null;
  if (critique) {
    log(`review: ${critique.pass ? "pass" : "not yet"} · ${critique.rooms.map((r) => `${r.room} ${r.score}`).join(", ")} — ${critique.summary}`);
    for (const r of critique.rooms) for (const p of r.problems) log(`  ${r.room}: ${p}`);
  }

  const house = {
    tour: tour.id,
    builtAt: new Date().toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    glb: built.length ? houseGlb : null,
    rooms: runs.map((r) => ({ room: r.key, summary: r.summary, report: r.report, error: r.error })),
    critique,
  };
  fs.writeFileSync(path.join(outRoot, "house.json"), JSON.stringify(house, null, 2));
  const models = reports.flatMap((r) => r.models);
  return {
    summary: `${built.length}/${rooms.length} room(s) built, ${models.filter((m) => m.status === "ok").length}/${models.length} model(s) made${built.length ? ` → ${path.relative(process.cwd(), houseGlb)}` : ""}`,
    house: path.join(outRoot, "house.json"),
  };
}
