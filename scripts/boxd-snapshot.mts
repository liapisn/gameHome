/**
 * The boxd snapshot every Blender run starts from (docs/boxd-models-plan.md, part 1), rebuilt from
 * scratch so it is reproducible: Ubuntu 24.04, 8 vCPU / 32 GB, Blender 5.3.0 checked against
 * blender.org's published sha256.
 *
 *   npx tsx --env-file=.env.local scripts/boxd-snapshot.mts                 # build gh-blender-5-3
 *   npx tsx --env-file=.env.local scripts/boxd-snapshot.mts --name test-1   # under another name
 *   npx tsx --env-file=.env.local scripts/boxd-snapshot.mts --replace       # save a new version over it
 *   npx tsx --env-file=.env.local scripts/boxd-snapshot.mts --clean         # delete leftover pool machines
 */
import { parseArgs } from "node:util";
import { boxd, POOL_LABEL, SNAPSHOT } from "../src/lib/boxd/runner";

const BLENDER = "5.3.0";
const MAJOR_MINOR = BLENDER.split(".").slice(0, 2).join(".");
const TARBALL = `blender-${BLENDER}-linux-x64.tar.xz`;
const BASE = `https://download.blender.org/release/Blender${MAJOR_MINOR}`;
// Shared libraries Blender's Linux build loads, even headless.
const APT = "curl xz-utils ca-certificates libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libice6 libx11-6 libxext6 libglu1-mesa";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: SNAPSHOT },
    replace: { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
  },
});
const b = boxd();

if (values.clean) {
  const leftovers = await b.machines.list({ labels: { ...POOL_LABEL } });
  for (const m of leftovers) {
    await b.machines.delete(m.id);
    console.log(`deleted ${m.name}`);
  }
  console.log(`${leftovers.length} pool machine(s) deleted`);
  await b.close();
  process.exit(0);
}

const existing = (await b.snapshots.list()).find((s) => s.name === values.name);
if (existing && !values.replace) {
  console.error(`Snapshot ${values.name} exists; pass --replace to rebuild it, or --name for another name`);
  await b.close();
  process.exit(1);
}

const m = await b.machines.create({ name: `gh-snapshot-${Date.now().toString(36)}`, image: "ubuntu:24.04", config: { vcpu: 8, memory: "32G" }, deleteAfter: 3600 });
try {
  await b.machines.waitUntilReady(m.id);
  const run = async (command: string) => {
    console.log(`$ ${command.length > 120 ? command.slice(0, 117) + "…" : command}`);
    const r = await b.machines.exec(m.id, { command: `( ${command} ) < /dev/null 2>&1`, timeout: 15 * 60_000 });
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}:\n${(r.stdout + r.stderr).split("\n").slice(-20).join("\n")}`);
    return r.stdout;
  };
  await run(`export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -yq --no-install-recommends ${APT}`);
  await run(`cd /tmp && curl -fsSLO ${BASE}/${TARBALL} && curl -fsSL ${BASE}/blender-${BLENDER}.sha256 | grep ' ${TARBALL}$' | sha256sum -c -`);
  await run(`tar -xJf /tmp/${TARBALL} -C /opt && ln -sf /opt/${TARBALL.replace(".tar.xz", "")}/blender /usr/local/bin/blender && rm /tmp/${TARBALL}`);
  const version = await run("blender --version");
  if (!version.includes(`Blender ${BLENDER}`)) throw new Error(`Unexpected version:\n${version}`);
  // Cycles on CPU must render: a tiny scene, one sample.
  await run(`blender -b --factory-startup --python-expr "import bpy; s=bpy.context.scene; s.render.engine='CYCLES'; s.cycles.device='CPU'; s.cycles.samples=1; s.render.resolution_x=s.render.resolution_y=64; s.render.filepath='/tmp/t.png'; bpy.ops.render.render(write_still=True); print('RENDER_OK')" | grep RENDER_OK`);
  await run("rm -f /tmp/t.png; apt-get clean; rm -rf /var/lib/apt/lists/*");

  // Saving under an existing name adds a version; the old one serves until the new one is ready.
  // The capture lands after create() returns: the machine must stay up until it is ready.
  const created = await b.snapshots.create(m.id, values.name!);
  for (const t0 = Date.now(); ; ) {
    const s = await b.snapshots.get(values.name!);
    if (s.status === "failed") throw new Error(`snapshot ${values.name} v${created.version} failed`);
    if (s.status === "ready" && (s.version ?? 0) >= created.version) break;
    if (Date.now() - t0 > 20 * 60_000) throw new Error(`snapshot ${values.name} not ready after 20 min (${s.status})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`snapshot ${values.name} v${created.version}: Blender ${BLENDER}, 8 vCPU / 32 GB`);
} finally {
  await b.machines.delete(m.id).catch(() => {});
  await b.close();
}
