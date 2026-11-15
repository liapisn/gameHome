"""
Prepare one library model (Amazon Berkeley Objects .glb) for placing: docs/library-small-plan.md, Part 5.
Runs on boxd (src/lib/blender/run-blender.ts), downloading the model there.

job: {
  "url": "<ABO .glb>",
  "out": "<dir>",
  "maxTris": 60000,
  "maxTexture": 1024
}
Writes to out: object.glb (metres, front -Y, origin at the centre of its footprint on the floor) and
result.json { ok, dims: [w, d, h], tris, error }. Always prints PREP_LIBRARY_DONE once result.json
is written (ok or not).
"""
import json
import os
import sys
import tempfile
import traceback
import urllib.request

import bpy
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
OUT = job["out"]
os.makedirs(OUT, exist_ok=True)
MAX_TRIS = int(job.get("maxTris", 60000))
MAX_TEX = int(job.get("maxTexture", 1024))
result = {"ok": False, "dims": None, "tris": 0, "error": None}


def finish():
    json.dump(result, open(os.path.join(OUT, "result.json"), "w"), indent=2)
    print("PREP_LIBRARY_DONE", "ok" if result["ok"] else "error")


def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


try:
    # Outside the project folder, so the runner doesn't copy the original back.
    src = os.path.join(tempfile.gettempdir(), "prep-library-in.glb")
    urllib.request.urlretrieve(job["url"], src)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no meshes in the model")

    # Bake parents and transforms into the meshes, then join them into one object.
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    for o in list(bpy.context.scene.objects):
        if o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)

    # Origin at the centre of the footprint, bottom at z = 0. The importer turns glTF +Z (the
    # model's front) into Blender -Y, our front; the orientation check fixes models that face otherwise.
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for v in obj.data.vertices:
        v.co -= shift
    obj.location = (0, 0, 0)

    tris = tris_of(obj)
    if tris > MAX_TRIS:
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = MAX_TRIS / tris
        bpy.ops.object.modifier_apply(modifier=mod.name)
        tris = tris_of(obj)

    for img in bpy.data.images:
        w, h = img.size[0], img.size[1]
        if max(w, h) > MAX_TEX:
            k = MAX_TEX / max(w, h)
            img.scale(max(1, round(w * k)), max(1, round(h * k)))
        if img.size[0] and not img.packed_file:
            img.pack()

    out = os.path.join(OUT, "object.glb")
    kw = dict(filepath=out, export_format="GLB", use_selection=False, export_apply=True)
    try:
        bpy.ops.export_scene.gltf(**kw, export_image_format="JPEG")
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)

    result.update(ok=True, dims=[round(hi.x - lo.x, 4), round(hi.y - lo.y, 4), round(hi.z - lo.z, 4)], tris=tris)
except Exception as e:  # noqa: BLE001
    result["error"] = f"{e}\n{traceback.format_exc()[-1500:]}"
finally:
    finish()
