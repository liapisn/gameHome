/**
 * Photos → furnished room, as a library: gate → detect → lift → check loop → RoomScene.
 * See docs/blender-loop-plan.md. Used by the `build:scene` CLI.
 *
 * Every model answer is cached as JSON in `workDir`, so re-running only re-does the geometry
 * unless `fresh` is set. Overlays and the top-down view are written there too, for checking by eye.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { type FloorPlan, ownerRoomIds, type Room, type RoomType } from "@/lib/floorplan";
import { applyCheck, checkPhoto, scoreScene, type CheckAnswer } from "@/lib/scene/check";
import { detectPhoto, detectVotes, roomKindConflict, voteDetections } from "@/lib/scene/detect";
import { gatePhoto, type GateAnswer } from "@/lib/scene/gate";
import { fillFromRules, liftDetection, mergeCandidates, NEAR_CONTACT, screenItems, type Candidate } from "@/lib/scene/lift";
import { boxesOverlay, topDown } from "@/lib/scene/overlay";
import { photoCamera, type PhotoCamera } from "@/lib/scene/project";
import type { PhotoDetection, PhotoGate, RoomScene, SceneItem } from "@/lib/scene/types";
import { type Tour, type TourPhoto, roomKey } from "@/lib/tour/types";

export interface BuildSceneOptions {
  tour: Tour;
  plan: FloorPlan;
  levelId: string;
  roomId: string;
  /** Folder for cached model answers, overlays and the top-down view. */
  workDir: string;
  /** Check-loop rounds (0 = detect + lift only). */
  rounds?: number;
  /** Ignore cached model answers. */
  fresh?: boolean;
  /** Parallel detect calls per photo, voted into one answer (default DETECT_VOTES, else 3; 1 = one call). */
  votes?: number;
  /** Ask the model to check each photo's placement (opt-in: see scripts/eval-gate.mts for how it scores). */
  modelGate?: boolean;
  /** Photo ids whose owner-assigned level differs from this one (fail at the gate), on top of `photo.owner`. */
  ownerMismatch?: Set<string>;
  /** Owner room type per photo id, on top of `photo.owner` (fail at the gate when it conflicts with the room). */
  ownerRoomType?: Map<string, RoomType>;
  /** Contact-rule thresholds, for tuning (scripts/eval-gate.mts). */
  gate?: { maxOutside?: number; strictPose?: boolean };
  log?: (m: string) => void;
}

interface PhotoCtx {
  photo: TourPhoto;
  cam: PhotoCamera;
  file: string;
  jpeg: Buffer;
}

/**
 * Floor contacts of nearby items (within NEAR_CONTACT of the camera) outside the room above this
 * share fail the photo. Far items don't count: those are often in a neighbouring room seen through
 * an opening. Chosen on the fixtures with scripts/eval-gate.mts: anything lower rejects right
 * photos of small rooms (listing-8218's 1.6 m bathroom and galley kitchen) and catches no more
 * wrong ones; the owner's floor and the room kind seen at detection do most of the rejecting.
 */
export const MAX_OUTSIDE = 0.7;
/**
 * Off by default: a photo whose pose isn't an edge fit must have MIN_CONTACTS nearby contacts, all
 * inside. On the fixtures it rejects right vanishing-point photos and nothing the rest misses.
 */
export const STRICT_POSE = false;
const MIN_CONTACTS = 3;
const MIN_GAIN = 0.02;

async function cached<T>(file: string, fresh: boolean, make: () => Promise<T>): Promise<T> {
  if (!fresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  const v = await make();
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
  return v;
}

export function scenePhotos(tour: Tour, levelId: string, roomId: string) {
  return tour.photos.filter((p) => p.levelId === levelId && p.roomId === roomId && p.pose);
}

/** Every room of a tour that has posed photos, as `${levelId}/${roomId}`. */
export function sceneRooms(tour: Tour) {
  return [...new Set(tour.photos.filter((p) => p.pose && p.levelId && p.roomId).map((p) => roomKey(p.levelId!, p.roomId!)))];
}

/**
 * Furnish every photographed room of a tour (the worker's optional step after buildTour). A room
 * that fails is logged and skipped; rooms where nothing came from photos are left out.
 */
export async function buildTourScenes(
  tour: Tour,
  plans: FloorPlan[],
  opts: { workRoot: string; rounds?: number; log?: (m: string) => void; onProgress?: (done: number, total: number) => void },
): Promise<{ scenes: RoomScene[]; calls: number }> {
  const rooms = sceneRooms(tour);
  const scenes: RoomScene[] = [];
  let calls = 0;
  for (const [i, key] of rooms.entries()) {
    opts.onProgress?.(i, rooms.length);
    const [levelId, roomId] = key.split("/");
    const level = tour.levels.find((l) => l.id === levelId);
    const plan = plans.find((p) => p.id === level?.planId);
    if (!plan) continue;
    try {
      const r = await buildRoomScene({ tour, plan, levelId, roomId, workDir: path.join(opts.workRoot, `${levelId}-${roomId}`), rounds: opts.rounds ?? 1, log: opts.log });
      calls += r.usage;
      if (r.scene.items.some((it) => it.source === "photos")) scenes.push(r.scene);
    } catch (err) {
      opts.log?.(`${key}: furnishing failed: ${(err as Error).message}`);
    }
  }
  opts.onProgress?.(rooms.length, rooms.length);
  return { scenes, calls };
}

export async function buildRoomScene(opts: BuildSceneOptions): Promise<{ scene: RoomScene; usage: number }> {
  const log = opts.log ?? (() => {});
  const { tour, plan, levelId, roomId, workDir } = opts;
  const fresh = !!opts.fresh;
  const votes = Math.max(1, opts.votes ?? detectVotes());
  fs.mkdirSync(workDir, { recursive: true });
  const level = tour.levels.find((l) => l.id === levelId);
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!level || !room) throw new Error(`No room ${levelId}/${roomId}`);
  const ceiling = level.ceilingHeight ?? plan.ceilingHeight;
  let calls = 0;
  let model = "";

  const ctxs: PhotoCtx[] = await Promise.all(
    scenePhotos(tour, levelId, roomId).map(async (photo) => {
      const file = path.join(tour.mediaRoot, photo.src);
      const jpeg = await sharp(file).rotate().resize(1600).jpeg({ quality: 88 }).toBuffer();
      return { photo, file, jpeg, cam: photoCamera(photo.pose!, photo.height / photo.width) };
    }),
  );
  log(`${room.name} (${levelId}/${roomId}): ${ctxs.length} posed photo(s)`);

  // ------------------------------------------------------------------ 0. gate
  const gates: PhotoGate[] = [];
  const passed: PhotoCtx[] = [];
  const otherFloor = (p: TourPhoto) => !!opts.ownerMismatch?.has(p.id) || (p.owner?.levelId != null && p.owner.levelId !== levelId);
  await Promise.all(
    ctxs.map(async (c) => {
      // What the owner said decides before any model call.
      const ownerType = opts.ownerRoomType?.get(c.photo.id) ?? c.photo.owner?.roomType;
      const ownerRoom = c.photo.owner?.roomId;
      const ownerRooms = ownerRoom ? ownerRoomIds(plan, ownerRoom) : null;
      const ownerFail = otherFloor(c.photo)
        ? "owner filed the photo under another floor"
        : ownerRooms?.size && !ownerRooms.has(room.id)
          ? `owner says it was taken in ${plan.rooms.find((r) => r.id === ownerRoom)?.name ?? ownerRoom}`
          : ownerType && roomKindConflict(room.type, ownerType)
          ? `owner says it shows a ${ownerType}, not a ${room.type}`
          : null;
      if (ownerFail) {
        gates.push({ id: c.photo.id, gate: "fail", reason: ownerFail });
        log(`  gate ${c.photo.id}: FAIL — ${ownerFail}`);
        return;
      }
      if (!opts.modelGate) {
        gates.push({ id: c.photo.id, gate: "pass", reason: "geometric checks only" });
        passed.push(c);
        return;
      }
      const g = await cached<{ pass: boolean; reason: string; answer: GateAnswer | null }>(path.join(workDir, `gate-${c.photo.id}.json`), fresh, async () => {
        calls++;
        const r = await gatePhoto({
          photoFile: c.file, photoJpeg: c.jpeg, cam: c.cam, plan, room, ceiling, fit: c.photo.fit,
          levelName: level.name,
        });
        fs.writeFileSync(path.join(workDir, `gate-${c.photo.id}.jpg`), r.overlay);
        model = r.model ?? model;
        return { pass: r.pass, reason: r.reason, answer: r.answer };
      });
      gates.push({ id: c.photo.id, gate: g.pass ? "pass" : "fail", reason: g.reason });
      if (g.pass) passed.push(c);
      log(`  gate ${c.photo.id}: ${g.pass ? "pass" : "FAIL"} — ${g.reason}`);
    }),
  );
  passed.sort((a, b) => a.photo.id.localeCompare(b.photo.id));
  gates.sort((a, b) => a.id.localeCompare(b.id));

  // ------------------------------------------------------------------ 1. detect
  let dets: PhotoDetection[] = [];
  const wrongKind = new Set<string>();
  await Promise.all(
    passed.map(async (c) => {
      const d =
        votes > 1
          ? voteDetections(
              (
                await cached(path.join(workDir, `detect-${c.photo.id}.v3-${votes}.json`), fresh, async () => {
                  const rs = await Promise.all(
                    Array.from({ length: votes }, async () => {
                      calls++;
                      const r = await detectPhoto({ photoJpeg: c.jpeg, room, levelName: level.name });
                      model = r.model;
                      return { cameraRoom: r.cameraRoom, items: r.items };
                    }),
                  );
                  return { cameraRoom: rs[0].cameraRoom, runs: rs };
                })
              ).runs,
            )
          : await cached(path.join(workDir, `detect-${c.photo.id}.v2.json`), fresh, async () => {
              calls++;
              const r = await detectPhoto({ photoJpeg: c.jpeg, room, levelName: level.name });
              model = r.model;
              return { cameraRoom: r.cameraRoom, items: r.items };
            });
      // Gate, free with detection: the photo clearly shows another kind of room.
      if (roomKindConflict(room.type, d.cameraRoom)) {
        const g = gates.find((x) => x.id === c.photo.id)!;
        g.gate = "fail";
        g.reason = `photo shows a ${d.cameraRoom}, not a ${room.type}`;
        wrongKind.add(c.photo.id);
        log(`  gate ${c.photo.id}: FAIL after detect — ${g.reason}`);
        return;
      }
      dets.push(...d.items.map((x, i) => ({ ...x, faceCorners: x.faceCorners ?? [], id: `${c.photo.id}:${i}`, photoId: c.photo.id })));
      log(`  detect ${c.photo.id} (${d.cameraRoom}): ${d.items.length} object(s) — ${d.items.map((x) => x.label).join(", ")}`);
    }),
  );
  for (let i = passed.length - 1; i >= 0; i--) if (wrongKind.has(passed[i].photo.id)) passed.splice(i, 1);

  // ------------------------------------------------------------------ 2. lift (+ floor-point sanity)
  const cams = new Map(passed.map((c) => [c.photo.id, c.cam]));
  const lift = (ds: PhotoDetection[]) => {
    const cands: Candidate[] = [];
    const stats = new Map<string, { inside: number; outside: number }>();
    for (const d of ds) {
      const r = liftDetection(d, cams.get(d.photoId)!, room, ceiling);
      const s = stats.get(d.photoId) ?? { inside: 0, outside: 0 };
      if (r.near) {
        s.inside += r.floorInside;
        s.outside += r.floorOutside;
      }
      stats.set(d.photoId, s);
      if (r.candidate) cands.push(r.candidate);
    }
    return { cands, stats };
  };

  const first = lift(dets);
  const maxOutside = opts.gate?.maxOutside ?? MAX_OUTSIDE;
  const strictPose = opts.gate?.strictPose ?? STRICT_POSE;
  for (const c of passed) {
    const photoId = c.photo.id;
    const s = first.stats.get(photoId) ?? { inside: 0, outside: 0 };
    const total = s.inside + s.outside;
    const g = gates.find((x) => x.id === photoId)!;
    g.contacts = s;
    const method = c.photo.fit?.method ?? "no fit";
    const reason =
      total >= 3 && s.outside / total > maxOutside
        ? `${s.outside}/${total} floor contacts within ${NEAR_CONTACT} m land outside the room`
        : strictPose && method !== "edges" && (total < MIN_CONTACTS || s.outside > 0)
          ? `pose from ${method} needs ${MIN_CONTACTS}+ nearby floor contacts, all inside (has ${s.inside} in, ${s.outside} out)`
          : null;
    if (reason) {
      g.gate = "fail";
      g.reason = reason;
      log(`  gate ${photoId}: FAIL after detect — ${g.reason}`);
      cams.delete(photoId);
      dets = dets.filter((d) => d.photoId !== photoId);
    }
  }
  const usable = passed.filter((c) => cams.has(c.photo.id));

  const assemble = (ds: PhotoDetection[]) => {
    const { cands } = lift(ds);
    const { kept: items, dropped } = screenItems(mergeCandidates(cands, room, ceiling), room.type);
    // Items left out on purpose aren't misses: score the rest against their own detections.
    const gone = new Set(dropped.flatMap((d) => d.item.detections));
    return { items, dropped, ...scoreScene(items, ds.filter((d) => !gone.has(d.id)), cams) };
  };
  const logDropped = (dropped: { item: SceneItem; reason: string }[]) => {
    for (const { item, reason } of dropped) log(`  drop ${item.id} "${item.label}": ${reason}`);
  };

  let state = { dets, ...assemble(dets) };
  log(`  lift: ${state.items.length} item(s), score ${state.score}`);
  logDropped(state.dropped);
  await writeOverlays(usable, state.items, workDir, "r0", room);

  // ------------------------------------------------------------------ 3. check loop
  const rounds: RoomScene["rounds"] = [{ round: 0, score: state.score, kept: true, changes: 0 }];
  for (let round = 1; round <= (opts.rounds ?? 3); round++) {
    let next = state.dets;
    let changes = 0;
    const answers = await Promise.all(
      usable.map(async (c) => {
        const visible = state.items; // the model sees every box drawn; ones out of frame it marks out-of-view
        const overlay = await boxesOverlay({ photoFile: c.file, cam: c.cam, items: visible });
        // Keyed by what was drawn, so a cached answer is only reused for the same boxes.
        const key = createHash("sha1").update(JSON.stringify(visible.map((i) => [i.id, i.x, i.y, i.w, i.d, i.h, i.rot]))).digest("hex").slice(0, 8);
        const a = await cached<CheckAnswer>(path.join(workDir, `check-r${round}-${c.photo.id}-${key}.json`), fresh, async () => {
          calls++;
          const r = await checkPhoto({ photoJpeg: c.jpeg, overlay, items: visible, roomName: room.name });
          model = r.model;
          return r.answer;
        });
        return { c, a };
      }),
    );
    for (const { c, a } of answers) {
      const r = applyCheck(next, state.items, c.photo.id, { ...a, missing: a.missing.map((m) => ({ ...m, faceCorners: m.faceCorners ?? [] })) });
      next = r.dets;
      changes += r.changes;
      const bad = a.items.filter((v) => v.verdict === "misplaced" || v.verdict === "nothing-there");
      log(`  check r${round} ${c.photo.id}: ${bad.map((v) => `${v.id} ${v.verdict}`).join(", ") || "all good"}${a.missing.length ? `; missing ${a.missing.map((m) => m.label).join(", ")}` : ""}`);
    }
    if (!changes) {
      rounds.push({ round, score: state.score, kept: false, changes });
      log(`  round ${round}: no changes, stop`);
      break;
    }
    const cand = { dets: next, ...assemble(next) };
    const gain = cand.score - state.score;
    const kept = gain > 0;
    rounds.push({ round, score: cand.score, kept, changes });
    log(`  round ${round}: ${changes} change(s), score ${state.score} → ${cand.score} ${kept ? "kept" : "rejected"}`);
    if (kept) {
      state = cand;
      logDropped(state.dropped);
      await writeOverlays(usable, state.items, workDir, `r${round}`, room);
    }
    if (gain < MIN_GAIN) break;
  }

  // ------------------------------------------------------------------ fill + write
  const items: SceneItem[] = [...state.items, ...fillFromRules(plan, room, state.items)];
  fs.writeFileSync(
    path.join(workDir, "topdown.png"),
    await topDown({ plan, room, items, cameras: usable.map((c) => ({ id: c.photo.id, pose: c.photo.pose! })) }),
  );
  fs.writeFileSync(path.join(workDir, "detections.json"), JSON.stringify(state.dets, null, 2));

  const scene: RoomScene = {
    tourId: tour.id,
    levelId,
    roomId,
    roomName: room.name,
    look: tour.looks[roomKey(levelId, roomId)] ?? null,
    items: items.map(round3),
    photos: gates,
    score: state.score,
    rounds,
    model: model || tour.model,
    builtAt: new Date().toISOString(),
  };
  log(`  done: ${state.items.length} from photos + ${items.length - state.items.length} from rules, score ${state.score}, ${calls} model call(s)`);
  return { scene, usage: calls };
}

async function writeOverlays(ctxs: PhotoCtx[], items: SceneItem[], dir: string, tag: string, room: Room) {
  await Promise.all(
    ctxs.map(async (c) =>
      fs.writeFileSync(
        path.join(dir, `boxes-${tag}-${c.photo.id}.jpg`),
        await boxesOverlay({ photoFile: c.file, cam: c.cam, items, title: `${c.photo.id} · ${room.name} · ${tag}` }),
      ),
    ),
  );
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
function round3(i: SceneItem): SceneItem {
  return { ...i, x: r3(i.x), y: r3(i.y), w: r3(i.w), d: r3(i.d), h: r3(i.h), rot: r3(i.rot), ...(i.elevation != null ? { elevation: r3(i.elevation) } : {}) };
}
