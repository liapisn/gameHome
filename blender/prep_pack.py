"""
Pack mode of prep_library.py: prepare every model of a CC0 furniture pack (Kenney, Quaternius) for
the library. See docs/library-full-plan.md, Part E, and the job format in prep_library.py.
"""
import json
import math
import os
import re
import traceback

import bpy
from mathutils import Vector


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "model"


def _import(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise RuntimeError(f"unsupported {ext}")


def _tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def _one_object():
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no meshes")
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
    return obj


def _bounds(obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def _thumb(obj, out, size=256):
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (1, 1, 1, 1)
        bg.inputs[1].default_value = 1.0
    lo, hi = _bounds(obj)
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.05)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    # Front three-quarter view from -Y (our front), a little from above.
    d = radius * 3.2
    az, el = math.radians(-35), math.radians(20)
    cam.location = centre + Vector((math.sin(az) * d * math.cos(el), -math.cos(az) * d * math.cos(el), math.sin(el) * d))
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(sun)
    scene.render.filepath = out
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def run(job):
    pack = job["pack"]
    os.makedirs(job["models"], exist_ok=True)
    os.makedirs(job["thumbs"], exist_ok=True)
    entries = []
    for src in job["files"]:
        name = os.path.splitext(os.path.basename(src))[0]
        mid = f"{pack}-{_slug(name)}"
        entry = {"name": name, "file": None, "dims": None, "tris": 0, "thumb": None}
        try:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            _import(src)
            obj = _one_object()
            lo, hi = _bounds(obj)
            # Some packs are in centimetres: nothing in a room is 20 m long.
            if max(hi - lo) > 20:
                obj.scale = (0.01, 0.01, 0.01)
                bpy.ops.object.transform_apply(scale=True)
                lo, hi = _bounds(obj)
            shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
            for v in obj.data.vertices:
                v.co -= shift
            obj.location = (0, 0, 0)
            out = os.path.join(job["models"], f"{mid}.glb")
            bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_apply=True)
            thumb = os.path.join(job["thumbs"], f"{mid}.png")
            try:
                _thumb(obj, thumb)
                entry["thumb"] = thumb
            except Exception as e:  # noqa: BLE001
                entry["thumbError"] = str(e)[:200]
            entry.update(file=out, dims=[round(hi.x - lo.x, 4), round(hi.y - lo.y, 4), round(hi.z - lo.z, 4)], tris=_tris(obj))
        except Exception as e:  # noqa: BLE001
            entry["error"] = f"{e}"[:300] + "\n" + traceback.format_exc()[-400:]
        entries.append(entry)
        print("PACK", mid, "ok" if entry["file"] else "error")
    os.makedirs(os.path.dirname(job["packJson"]), exist_ok=True)
    json.dump(entries, open(job["packJson"], "w"), indent=1)
