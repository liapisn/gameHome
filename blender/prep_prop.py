"""
Prepare one generated model for placing: join its meshes, turn its front to −Y, scale it to the
item's real size, put the origin at the centre of its footprint on the floor, export a GLB.

    blender -b --factory-startup -P blender/prep_prop.py -- <job.json>

Job: { "glb": "<raw generator output>", "generator": "tripo-h31" | "meshy" | "",
       "size": {"w", "d", "h"},            # metres: w along the front, d front to back, h height
       "fit": "upright" | "flat" | "exact", # exact: stretch each axis to the target (up to 15%)
       "out": "<prepared .glb>" }
Writes <out>.json: { "dims": [w, d, h] as built, "tris": n, "scale": s }.

Adapted from https://github.com/apekshik/anyscene (scenes/tokyo-electronics-repair/scripts/prep.py
and load_asset in endpoint/assemble.py), MIT licence. Changed: driven by a job file, no
decimation, textures kept at full size (full detail was chosen), exported as GLB.
"""
import json
import math
import sys

import bpy
from mathutils import Matrix, Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
# Where each generator's front points, in degrees from −Y (AnyScene measured these).
FRONT_YAW = {"tripo-h31": 90, "meshy": 0}
MAX_STRETCH = 0.15

bpy.ops.wm.read_factory_settings(use_empty=True)
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=job["glb"])
new = [o for o in bpy.data.objects if o not in before]
for o in new:
    o.rotation_mode = "XYZ"  # glTF imports come in as quaternions; rotation_euler is ignored otherwise
    # Tripo H3.1 with orientation=align_image bakes a ±20–30° turn into the node to match the
    # reference's three-quarter view: clear it so only the generator's fixed front offset remains.
    if job.get("generator") == "tripo-h31" and o.parent is None:
        o.rotation_euler = (o.rotation_euler.x, o.rotation_euler.y, 0)
meshes = [o for o in new if o.type == "MESH"]
if not meshes:
    raise SystemExit("PREP_FAILED no meshes in " + job["glb"])
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
mw = ob.matrix_world.copy()
ob.parent = None
ob.matrix_world = mw
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.data.objects):
    if o is not ob:
        bpy.data.objects.remove(o)

# Front to −Y.
ob.data.transform(Matrix.Rotation(-math.radians(FRONT_YAW.get(job.get("generator", ""), 0)), 4, "Z"))

# Bounds by vertices (bound_box lags after data transforms).
vs = [v.co for v in ob.data.vertices]
lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
dims = hi - lo
ob.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))

w, d, h = job["size"]["w"], job["size"]["d"], job["size"]["h"]
fit = job.get("fit", "upright")
if fit == "flat":
    s = max(w, d) / max(dims.x, dims.y, 1e-4)
else:
    s = h / max(dims.z, 1e-4)
ob.data.transform(Matrix.Scale(s, 4))
if fit == "exact":
    # Built-to-measure things must meet their wall: stretch each axis to the target, within limits.
    sx = min(1 + MAX_STRETCH, max(1 - MAX_STRETCH, w / max(dims.x * s, 1e-4)))
    sy = min(1 + MAX_STRETCH, max(1 - MAX_STRETCH, d / max(dims.y * s, 1e-4)))
    ob.data.transform(Matrix.Diagonal((sx, sy, 1, 1)))

for p in ob.data.polygons:
    p.use_smooth = True
ob.name = ob.data.name = "model"
vs = [v.co for v in ob.data.vertices]
built = [max(v.x for v in vs) - min(v.x for v in vs), max(v.y for v in vs) - min(v.y for v in vs), max(v.z for v in vs) - min(v.z for v in vs)]
ob.data.calc_loop_triangles()
tris = len(ob.data.loop_triangles)

bpy.ops.object.select_all(action="DESELECT")
ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=job["out"], use_selection=True, export_apply=True, export_yup=True)
json.dump({"dims": [round(x, 4) for x in built], "tris": tris, "scale": s}, open(job["out"] + ".json", "w"))
print("PREP_OK", job["out"], "dims", ["%.2f" % x for x in built], "tris", tris)
