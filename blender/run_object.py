"""
Run one model-written furniture function on a boxd machine (docs/boxd-models-plan.md, part 3, step 4).
Only ever on boxd, on a machine that is deleted afterwards (src/lib/blender/run-blender.ts).

job: {
  "code": "<path of a .py file defining build(gh, size)>",
  "size": {"w": .., "d": .., "h": ..},      target, metres
  "free": ["w", "d"],                        axes not held to the target (plants), optional
  "outDir": "...", "res": 640, "samples": 24
}
Writes to outDir: result.json, object.glb, front/back/left/right/top/clay .png.
Always prints RUN_OBJECT_DONE once the result is written (ok or not); result.json says which.
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gh_parts as gh  # noqa: E402

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
OUT = job["outDir"]
os.makedirs(OUT, exist_ok=True)
SIZE = (job["size"]["w"], job["size"]["d"], job["size"]["h"])
FREE = set(job.get("free", []))
TOLERANCE = 0.30
MAX_TRIS = 500_000
result = {"ok": False, "error": None, "built": None, "dims": None, "scale": None, "tris": 0, "parts": [], "renders": {}}


def finish():
    json.dump(result, open(os.path.join(OUT, "result.json"), "w"), indent=2)
    print("RUN_OBJECT_DONE", "ok" if result["ok"] else "error")


def fail(msg):
    result["error"] = msg
    finish()
    sys.exit(0)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------ build
code = open(job["code"]).read()
ns = {"__name__": "model_code", "gh": gh, "bpy": bpy, "math": math, "Vector": Vector, "Matrix": Matrix}
try:
    exec(compile(code, "build.py", "exec"), ns)
    if "build" not in ns:
        fail("The code defines no build(gh, size) function.")
    ns["build"](gh, SIZE)
except SystemExit:
    raise
except Exception:
    tb = traceback.format_exc()
    # Keep the part of the traceback inside the model's own code and gh_parts.
    fail("The code raised an error:\n" + tb[-2500:])

# Everything the code left in the scene. Curves and text become meshes; lights, cameras and empties go.
bpy.context.view_layer.update()
for o in list(scene.objects):
    if o.type in ("CURVE", "FONT", "SURFACE", "META"):
        gh._apply_modifiers(o)
for o in list(scene.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in scene.objects if o.type == "MESH" and len(o.data.polygons)]
if not meshes:
    fail("The code made no mesh: build() must create objects (gh_parts shapes or bpy meshes).")

# Bake modifiers and transforms, so every vertex is in object space as finally shaped.
for o in meshes:
    gh._apply_modifiers(o)
    gh._bake(o)
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
result["tris"] = tris
result["parts"] = sorted(o.name for o in meshes)
if tris > MAX_TRIS:
    fail(f"Too heavy: {tris} triangles (limit {MAX_TRIS}). Use fewer segments, less subdivision, fewer leaves.")

pts = [v.co for o in meshes for v in o.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
if not all(math.isfinite(c) for c in (*lo, *hi)):
    fail("Non-finite coordinates (NaN or infinity) in the mesh.")
built = hi - lo
result["built"] = [round(c, 4) for c in built]
if lo.z < -0.05 * SIZE[2] - 0.01:
    fail(f"Parts go {-lo.z:.3f} m below the floor (z < 0). The object must stand on z = 0.")

# ------------------------------------------------------------------ fit to the target size
off = []
for axis, name in enumerate("wdh"):
    if name in FREE:
        continue
    ratio = built[axis] / max(SIZE[axis], 1e-3)
    if abs(ratio - 1) > TOLERANCE:
        off.append(f"{name} is {built[axis]:.2f} m, target {SIZE[axis]:.2f} m")
if off:
    fail("Size off by more than 30%: " + "; ".join(off) + ". Build to the target size (w along X, d along Y, h up).")

# Re-centre: footprint centre at the origin, bottom on z = 0; then scale each held axis exactly.
centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
scale = [1.0 if name in FREE else SIZE[a] / max(built[a], 1e-6) for a, name in enumerate("wdh")]
if "w" in FREE and "d" in FREE:
    # Plants: keep proportions, sized by height.
    scale[0] = scale[1] = scale[2]
m = Matrix.Diagonal((*scale, 1.0)) @ Matrix.Translation(-centre)
for o in meshes:
    if o.data.users > 1:
        o.data = o.data.copy()
    o.data.transform(m)
    o.data.update()
result["scale"] = [round(s, 4) for s in scale]
result["dims"] = [round(b * s, 4) for b, s in zip(built, scale)]
W, D, H = result["dims"]

# ------------------------------------------------------------------ export (before any studio objects exist)
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
glb = os.path.join(OUT, "object.glb")
bpy.ops.export_scene.gltf(filepath=glb, use_selection=True, export_apply=True, export_yup=True)
result["glb"] = glb

# ------------------------------------------------------------------ studio renders
floor_mat = gh.painted("#8f8c87", 0)  # mid grey: white and cream furniture stay visible
floor = gh.box((40, 40, 0.01), at=(0, 0, -0.01), mat=floor_mat, name="studio_floor")
world = bpy.data.worlds.new("studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.92, 0.92, 0.94, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
scene.world = world
radius = 0.5 * math.sqrt(W * W + D * D + H * H)
for name, energy, loc in (("key", 70, (-1.2, -1.5, 1.8)), ("fill", 25, (1.6, -0.8, 1.0)), ("rim", 35, (0.4, 1.8, 1.6))):
    light = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
    light.data.energy = energy * max(radius, 0.4) ** 2
    light.data.size = max(radius, 0.5) * 1.5
    light.location = Vector(loc) * max(radius * 2.2, 1.0) + Vector((0, 0, H / 2))
    light.rotation_euler = (Vector((0, 0, H / 2)) - light.location).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(light)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.lens = 50
scene.collection.objects.link(cam)
scene.camera = cam
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = job.get("samples", 24)
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "Standard"
RES = job.get("res", 640)
scene.render.resolution_x = scene.render.resolution_y = RES
target = Vector((0, 0, H / 2))
fov = cam.data.angle
dist = radius / math.sin(fov / 2) * 1.08

# (name, azimuth from the front in degrees, anticlockwise seen from above; elevation in degrees)
VIEWS = [("front", 0, 12), ("left", -40, 22), ("right", 40, 22), ("back", 180, 12), ("top", 0, 75), ("clay", -35, 25)]
clay = gh.painted("#bdbdbd", 0)
for name, az, el in VIEWS:
    a, e = math.radians(az), math.radians(el)
    # Front view looks from -Y towards +Y; positive azimuth swings the camera to the object's right (+X side seen from the front is the viewer's right).
    cam.location = target + dist * Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    if name == "clay":
        saved = {o.name: list(o.data.materials) for o in meshes}
        for o in meshes:
            o.data.materials.clear()
            o.data.materials.append(clay)
    path = os.path.join(OUT, f"{name}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    result["renders"][name] = path
    if name == "clay":
        for o in meshes:
            o.data.materials.clear()
            for mt in saved[o.name]:
                o.data.materials.append(mt)

result["ok"] = True
finish()
