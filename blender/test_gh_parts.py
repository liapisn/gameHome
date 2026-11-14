"""
Calls every function in gh_parts once, checks each result, and renders a labelled contact sheet.

  job: {"outDir": "..."}  →  outDir/contact.png, outDir/report.json; prints GH_PARTS_OK when every check passed.
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gh_parts as gh  # noqa: E402

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
out_dir = job["outDir"]
os.makedirs(out_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

oak, white, grey = gh.wood("#b08a5a", 0.4), gh.painted("#efece6", 0.3), gh.fabric("#7d8590", 0.6)
CASES = [
    ("box", lambda: gh.box((0.5, 0.4, 0.3), mat=oak)),
    ("rounded_box", lambda: gh.rounded_box((0.5, 0.4, 0.3), 0.05, mat=white)),
    ("cylinder", lambda: gh.cylinder(0.2, 0.4, mat=gh.metal("#3a3a3a", 0.6))),
    ("cone", lambda: gh.cone(0.22, 0.08, 0.4, mat=gh.ceramic("#c96f4a"))),
    ("sphere", lambda: gh.sphere(0.2, mat=gh.chrome())),
    ("tube", lambda: gh.tube([(-0.25, 0, 0.0), (-0.25, 0, 0.45), (0.25, 0, 0.45), (0.25, 0, 0.0)], 0.015, mat=gh.metal("#b8893a", 0.3))),
    ("panel", lambda: gh.panel(0.5, 0.5, mat=oak)),
    ("slab_top", lambda: gh.slab_top(0.5, 0.4, 0.04, 0.03, 0.01, mat=gh.stone("#e3e0d8", 0.4))),
    ("leg", lambda: gh.leg(0.45, 0.05, 0.03, "square", mat=oak)),
    ("leg_set", lambda: gh.join(gh.leg_set(0.5, 0.4, 0.4, 0.04, 0.04, 0.025, "round", mat=gh.metal("#222222", 0.5)) + [gh.slab_top(0.5, 0.4, 0.03, at=(0, 0, 0.4), mat=oak)], "table")),
    ("cushion", lambda: gh.cushion(0.55, 0.55, 0.16, 0.6, mat=grey)),
    ("pillow", lambda: gh.pillow(0.45, 0.45, mat=gh.fabric("#c9b48a", 0.3))),
    ("door_front flat", lambda: gh.door_front(0.4, 0.6, "flat", "bar", mat=white)),
    ("door_front shaker", lambda: gh.door_front(0.4, 0.6, "shaker", "knob", mat=gh.painted("#5d7a6a", 0.2))),
    ("door_front glass", lambda: gh.door_front(0.4, 0.6, "glass", "edge", mat=oak, handle_mat=gh.metal("#222222"))),
    ("drawer_front", lambda: gh.drawer_front(0.5, 0.18, "bar", mat=white)),
    ("handle", lambda: gh.handle("bar", 0.2, at=(0, 0, 0.106), mat=gh.chrome(), vertical=True)),
    ("shelf_unit", lambda: gh.shelf_unit(0.5, 0.3, 0.7, 2, True, mat=oak, back_mat=white)),
    ("frame", lambda: gh.frame(0.5, 0.6, 0.04, mat=gh.metal("#1f1f1f"))),
    ("mattress", lambda: gh.mattress(0.5, 0.6, 0.2, mat=gh.fabric("#f3f1ec", 0.2))),
    ("lampshade", lambda: gh.join([gh.lampshade(0.2, 0.15, 0.22, at=(0, 0, 0.3), mat=gh.fabric("#efe6d2", 0.4)), gh.cylinder(0.01, 0.3, mat=gh.metal("#b8893a")), gh.cylinder(0.1, 0.02, mat=gh.metal("#b8893a")), gh.sphere(0.04, at=(0, 0, 0.3), mat=gh.emissive())], "lamp")),
    ("plant_pot + foliage", lambda: gh.join([gh.plant_pot(0.15, 0.25, mat=gh.ceramic("#e9e4da")), gh.foliage(0.25, 0.5, 0.8, at=(0, 0, 0.22), seed=3)], "plant")),
    ("mirror_x", lambda: gh.join([(lambda a: [a, gh.mirror_x(a)])(gh.leg(0.5, 0.06, 0.03, at=(-0.2, 0, 0), mat=oak))][0], "splayed")),
    ("array", lambda: gh.join(gh.array(gh.box((0.06, 0.3, 0.4), at=(-0.21, 0, 0), mat=gh.rattan()), 5, (0.105, 0, 0)), "slats")),
    ("bevel + smooth", lambda: gh.smooth(gh.bevel(gh.box((0.5, 0.4, 0.3), mat=gh.leather("#6b4128")), 0.04, 4))),
    ("move + rotate", lambda: gh.rotate(gh.move(gh.box((0.5, 0.15, 0.3), mat=gh.plastic("#d84a3a")), dz=0.05), 30)),
    ("glass", lambda: gh.box((0.4, 0.3, 0.4), mat=gh.glass())),
]

COLS, STEP = 7, 1.0
report, ok = [], True
for i, (label, make) in enumerate(CASES):
    entry = {"case": label}
    try:
        before = set(bpy.data.objects)
        obj = make()
        cx, cy = (i % COLS) * STEP, -(i // COLS) * STEP * 1.6
        gh.move(obj, cx, cy, 0)
        bpy.context.view_layer.update()
        if obj.type != "MESH" or not obj.data.polygons:
            raise ValueError("no mesh")
        pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        if not all(math.isfinite(c) for c in (*lo, *hi)):
            raise ValueError("non-finite bounds")
        # Everything stands on the floor (the move+rotate case sits 5 cm up on purpose).
        floor = 0.05 if label == "move + rotate" else 0.0
        if abs(lo.z - floor) > 0.005:
            raise ValueError(f"bottom at z={lo.z:.3f}, expected {floor}")
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        stray = [o.name for o in set(bpy.data.objects) - before if o != obj]
        entry.update(dims=[round(c, 3) for c in hi - lo], tris=tris, objects_left=stray, ok=True)
        t = bpy.data.curves.new(label, "FONT")
        t.body = label
        t.size = 0.07
        t.align_x = "CENTER"
        txt = bpy.data.objects.new("label_" + label, t)
        scene.collection.objects.link(txt)
        txt.location = (cx, cy - 0.45, 0.001)
        txt.data.materials.append(gh.painted("#222222", 0))
    except Exception:
        ok = False
        entry.update(ok=False, error=traceback.format_exc(limit=3))
    report.append(entry)
    print(("  ok  " if entry["ok"] else "  FAIL") + f" {label}: " + (f"{entry.get('dims')} {entry.get('tris')} tris" if entry["ok"] else entry["error"].splitlines()[-1]))

# Floor, light, camera; Cycles on CPU.
rows = math.ceil(len(CASES) / COLS)
gh.box((COLS * STEP + 1, rows * STEP * 1.6 + 1, 0.01), at=((COLS - 1) * STEP / 2, -(rows - 1) * STEP * 0.8, -0.01), mat=gh.painted("#d9d6d0", 0), name="floor")
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.9, 0.9, 0.92, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
scene.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = "ORTHO"
cam.data.ortho_scale = COLS * STEP + 0.6
centre = Vector(((COLS - 1) * STEP / 2, -(rows - 1) * STEP * 0.8, 0.15))
cam.location = centre + Vector((0, -8, 8))
cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.collection.objects.link(cam)
scene.camera = cam
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = job.get("samples", 24)
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1800, 1200
scene.view_settings.view_transform = "Standard"
scene.render.filepath = os.path.join(out_dir, "contact.png")
bpy.ops.render.render(write_still=True)

json.dump(report, open(os.path.join(out_dir, "report.json"), "w"), indent=2)
failed = [r["case"] for r in report if not r["ok"]]
print("GH_PARTS_OK" if ok else f"GH_PARTS_FAILED {failed}")
