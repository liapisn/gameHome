"""
Stage 4 (look): build a room in Blender from a job file written by scripts/blender-scene.mts.

    blender -b --factory-startup -P blender/build_scene.py -- <job.json>

Job: {
  "mode": "selftest" | "build",
  "shell": "<house .glb in plan space, three.js Y-up>",
  "items": [{ "id", "label", "kind", "color", "material", "box": [x0, y0, x1, y1, z0, z1],
              # a generated model instead of the box (prepared: metres, front −Y, origin on the floor):
              "asset": "<prepared .glb>", "pos": [x, y, z], "rot": <radians, plan>, "scale": s,
              # a picture: a framed plane at the box, textured with this image:
              "image": "<crop .jpg>", "size": [w, h] }],
  "turnAll": <degrees added to every model's rotation, for orientation renders>,
  "cameras": [{ "id", "pose": {x, y, yaw, pitch, hfov, height, horizon}, "width", "height" }],
  "probes": [[x, y, z], ...],          # plan points to project (selftest)
  "lights": [[x, y, z], ...],          # plan points for interior lights
  "outDir": "...", "glb": "<items .glb path or null>", "samples": 32
}
Plan (x, y, h) ↔ Blender (x, −y, h): the glTF importer turns three.js (x, h, y) into exactly that.
Writes <outDir>/result.json with Blender's own projection of the probes per camera, and
<outDir>/render-<camera>.png per camera.
"""

import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
out_dir = job["outDir"]
os.makedirs(out_dir, exist_ok=True)


def P(x, y, z):
    return Vector((x, -y, z))


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------ render settings
# Cycles on CPU: the boxd machines have no GPU, and there Eevee is slower than Cycles.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = job.get("samples", 32)
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.95, 0.94, 0.92, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
scene.world = world

# ------------------------------------------------------------------ shell
if job.get("shell"):
    bpy.ops.import_scene.gltf(filepath=job["shell"])

# ------------------------------------------------------------------ items
ROUGH = {"fabric": (0.95, 0.0), "wood": (0.55, 0.0), "metal": (0.3, 0.9), "ceramic": (0.15, 0.0),
         "glass": (0.05, 0.0), "stone": (0.45, 0.0), "plastic": (0.4, 0.0), "leather": (0.5, 0.0)}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(color, kind):
    name = f"{color}-{kind}"
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    h = (color or "#cccccc").lstrip("#")
    rgb = [srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    rough, metal = ROUGH.get(kind, (0.6, 0.0))
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    return m


# The room's observed floor on the shell. Walls stay neutral, as in the viewer: wall meshes are
# shared between rooms and one photo's colour is often a single feature wall.
look = job.get("look")
if look and look.get("floor"):
    for o in list(scene.objects):
        if o.type == "MESH" and o.name.startswith("floor__") and o.name.endswith(f"__{job.get('roomId', '')}"):
            o.data.materials.clear()
            o.data.materials.append(material(look["floor"], "stone"))

items = []
_assets = {}


def asset_mesh(path):
    """A prepared model's mesh, imported once; every placement links the same mesh data."""
    if path in _assets:
        return _assets[path]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if len(meshes) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        meshes = [bpy.context.view_layer.objects.active]
    ob = meshes[0]
    mw = ob.matrix_world.copy()
    ob.parent = None
    ob.matrix_world = mw
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    data = ob.data
    for o in new:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o)
    _assets[path] = data
    return data


def picture(it):
    """A picture or mirror: a thin framed plane, its image on the room side."""
    w, h = it["size"]
    x0, y0, x1, y1, z0, z1 = it["box"]
    mesh = bpy.data.meshes.new(it["id"])
    hw, hh = w / 2, h / 2
    mesh.from_pydata([(-hw, 0, -hh), (hw, 0, -hh), (hw, 0, hh), (-hw, 0, hh)], [], [(0, 1, 2, 3)])
    mesh.uv_layers.new(name="UV")
    for loop, uv in zip(mesh.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        mesh.uv_layers["UV"].data[loop.index].uv = uv
    obj = bpy.data.objects.new(it["id"], mesh)
    m = bpy.data.materials.new(it["id"] + "-img")
    m.use_nodes = True
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(it["image"])
    m.node_tree.links.new(tex.outputs["Color"], m.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.5
    obj.data.materials.append(m)
    # Front −Y at rot 0, like everything else; stand it 1 cm off the wall-side of its box.
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = (0, 0, it.get("rot", 0))
    obj.location = P((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    frame = obj.modifiers.new("frame", "SOLIDIFY")
    frame.thickness = 0.02
    return obj


turn_all = math.radians(job.get("turnAll", 0))
for it in job.get("items", []):
    if it.get("asset"):
        obj = bpy.data.objects.new(it["id"], asset_mesh(it["asset"]))
        x, y, z = it["pos"]
        obj.location = P(x, y, z)
        obj.rotation_mode = "XYZ"
        # Plan rotation r (three.js, about Y) is the same angle about Blender's Z under (x, −y, h).
        obj.rotation_euler = (0, 0, it.get("rot", 0) + (turn_all if it.get("turnable", True) else 0))
        s = it.get("scale", 1)
        obj.scale = (s, s, s)
        obj["label"] = it.get("label", "")
        obj["kind"] = it.get("kind", "")
        scene.collection.objects.link(obj)
        items.append(obj)
        continue
    if it.get("image"):
        obj = picture(it)
        scene.collection.objects.link(obj)
        items.append(obj)
        continue
    x0, y0, x1, y1, z0, z1 = it["box"]
    mesh = bpy.data.meshes.new(it["id"])
    # Box in plan space, converted per vertex (no object rotation needed: rotations are 90° steps).
    vs = [P(x, y, z) for z in (z0, z1) for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh.from_pydata([tuple(v) for v in vs], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(it["id"], mesh)
    obj["label"] = it.get("label", "")
    obj["kind"] = it.get("kind", "")
    scene.collection.objects.link(obj)
    obj.data.materials.append(material(it.get("color"), it.get("material")))
    bev = obj.modifiers.new("bevel", "BEVEL")
    bev.width = min(0.015, (min(x1 - x0, y1 - y0, z1 - z0)) / 4)
    bev.segments = 2
    items.append(obj)

# ------------------------------------------------------------------ lights
for i, (x, y, z) in enumerate(job.get("lights", [])):
    ld = bpy.data.lights.new(f"light{i}", "POINT")
    ld.energy = 70
    ld.shadow_soft_size = 0.5
    lo = bpy.data.objects.new(f"light{i}", ld)
    lo.location = P(x, y, z)
    scene.collection.objects.link(lo)

# ------------------------------------------------------------------ cameras
cam_data = bpy.data.cameras.new("photo")
cam = bpy.data.objects.new("photo", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.clip_start = 0.05
cam_data.clip_end = 100

result = {"blender": bpy.app.version_string, "engine": scene.render.engine, "cameras": [], "checks": []}

# ------------------------------------------------------------------ checks
# Simple placement checks on what was built: floor things that float or sink, anything outside
# the room. (Plan coordinates: Blender y is −plan y.)
bpy.context.view_layer.update()
room_box = job.get("roomBox")  # [x0, y0, x1, y1] in plan space
for o, it in zip(items, job.get("items", [])):
    if not it.get("asset"):
        continue
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    zs = [p.z for p in pts]
    px = [p.x for p in pts]
    py = [-p.y for p in pts]
    entry = {"id": it["id"], "size": [max(px) - min(px), max(py) - min(py), max(zs) - min(zs)]}
    if it.get("floor") and abs(min(zs)) > 0.02:
        entry["FLOAT"] = round(min(zs), 3)
    if room_box and (min(px) < room_box[0] - 0.1 or max(px) > room_box[2] + 0.1 or min(py) < room_box[1] - 0.1 or max(py) > room_box[3] + 0.1):
        entry["OUT"] = [round(min(px), 2), round(min(py), 2), round(max(px), 2), round(max(py), 2)]
    result["checks"].append(entry)
for c in job.get("cameras", []):
    pose = c["pose"]
    W, H = c["width"], c["height"]
    scene.render.resolution_x = W
    scene.render.resolution_y = H
    scene.render.resolution_percentage = 100
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.angle = math.radians(pose["hfov"])
    # Off-axis frustum: the horizon sits at image row `horizon` (0 = top). Shift is in units of the
    # larger sensor side (width); a positive shift_y moves the view up, so the horizon moves down.
    cam_data.shift_y = (pose.get("horizon", 0.5) - 0.5) * H / W
    cam_data.shift_x = 0
    cam.location = P(pose["x"], pose["y"], pose["height"])
    # Camera looks down local −Z. (90° + pitch) about X faces +Y and tilts; then yaw about Z.
    # Plan yaw ψ (0 = +x, 90 = +y) is Blender heading (cos ψ, −sin ψ): rotation_z = −(ψ + 90°).
    cam.rotation_mode = "XYZ"
    cam.rotation_euler = (math.radians(90 + pose.get("pitch", 0)), 0, -math.radians(pose["yaw"] + 90))
    bpy.context.view_layer.update()

    probes = []
    for p in job.get("probes", []):
        v = world_to_camera_view(scene, cam, P(*p))
        probes.append([v.x, 1 - v.y, v.z])  # → (u, v) with v down, plus depth
    entry = {"id": c["id"], "probes": probes}
    if job.get("render", True):
        path = os.path.join(out_dir, f"render-{c['id']}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        entry["render"] = path
    result["cameras"].append(entry)

# ------------------------------------------------------------------ export
if job.get("glb") and items:
    bpy.ops.object.select_all(action="DESELECT")
    for o in items:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=job["glb"],
        use_selection=True,
        export_apply=True,
        export_draco_mesh_compression_enable=True,
        export_extras=True,
    )
    result["glb"] = job["glb"]

json.dump(result, open(os.path.join(out_dir, "result.json"), "w"), indent=2)
print("BUILD_SCENE_OK", os.path.join(out_dir, "result.json"))
