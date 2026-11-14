/**
 * Export a FloorPlan as a .glb (+ the plan JSON beside it) for Unreal / Blender.
 *
 *   npm run export:glb                          # demo plan → exports/demo-athens-2br/
 *   npm run export:glb -- --plan path/plan.json # any FloorPlan JSON
 *   npm run export:glb -- --no-ceilings         # dollhouse-only geometry
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { buildDollhouseScene } from "../src/lib/dollhouse-geometry";
import { type FloorPlan, demoPlan } from "../src/lib/floorplan";

// GLTFExporter's binary path uses the browser FileReader; Node has Blob but no FileReader.
if (typeof globalThis.FileReader === "undefined") {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
        this.onloadend?.();
      });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;
}

/**
 * GLTFExporter names nodes but not meshes, and Unreal's importer names StaticMesh assets after
 * the glTF mesh. Copy each node name onto its mesh and rebuild the GLB with the new JSON chunk.
 */
function nameMeshesAfterNodes(glb: Buffer): Buffer {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
  for (const node of json.nodes ?? []) {
    if (node.mesh !== undefined && node.name) json.meshes[node.mesh].name = node.name;
  }
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const rest = glb.subarray(20 + jsonLen); // BIN chunk (header + data), unchanged
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  return Buffer.concat([header, jsonBuf, rest]);
}

const { values } = parseArgs({
  options: {
    plan: { type: "string" },
    out: { type: "string", default: "exports" },
    "no-ceilings": { type: "boolean", default: false },
  },
});

const plan: FloorPlan = values.plan ? JSON.parse(await readFile(values.plan, "utf8")) : demoPlan;
const scene = buildDollhouseScene(plan, { ceilings: !values["no-ceilings"] });

const glb = nameMeshesAfterNodes(
  Buffer.from((await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer),
);

const dir = path.resolve(values.out!, plan.id);
await mkdir(dir, { recursive: true });
const glbPath = path.join(dir, `${plan.id}.glb`);
await writeFile(glbPath, glb);
await writeFile(path.join(dir, `${plan.id}.plan.json`), JSON.stringify(plan, null, 2));

console.log(`${glbPath}  (${(glb.byteLength / 1024).toFixed(1)} KB, ${scene.children.length} meshes)`);
