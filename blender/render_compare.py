"""
Same-light renders of candidate models, so they can be judged fairly: every candidate gets the
same studio light and camera fit, textured (front three-quarter and back) and clay with wireframe.

    blender -b --factory-startup -P blender/render_compare.py -- <job.json>

Job: { "candidates": [{"name", "glb"}], "out": "<dir>", "res": 768, "samples": 48 }
Writes <out>/<name>_{beauty,back,clay}.png and <out>/stats.json.

Adapted from https://github.com/apekshik/anyscene (pipeline/render_compare.py), MIT licence.
Changed: driven by a job file; GPU through Metal/CUDA/OptiX/HIP, whichever exists, else CPU.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
OUT = job["out"]
os.makedirs(OUT, exist_ok=True)
RES = job.get("res", 768)
_VER = "%d.%d" % bpy.app.version[:2]
_BIN = os.path.dirname(bpy.app.binary_path)
HDRI = next((p for p in (os.path.join(_BIN, _VER), os.path.join(_BIN, "..", "Resources", _VER)) if os.path.isdir(p)), os.path.join(_BIN, _VER))
HDRI = os.path.join(HDRI, "datafiles", "studiolights", "world", "studio.exr")


def use_gpu(sc):
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "METAL", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devs = [d for d in prefs.devices if d.type == kind]
        if devs:
            for d in prefs.devices:
                d.use = d.type == kind
            sc.cycles.device = "GPU"
            return kind
    sc.cycles.device = "CPU"
    return "CPU"


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    use_gpu(sc)
    sc.cycles.samples = job.get("samples", 48)
    sc.cycles.use_denoising = True
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    if os.path.exists(HDRI):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(HDRI)
        nt.links.new(env.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.6
    return sc


def add_light(name, loc, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, "AREA")
    d.energy, d.size, d.color = energy, size, color
    o = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (-Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def clay(objs):
    m = bpy.data.materials.new("clay")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.6
    wire = nt.nodes.new("ShaderNodeWireframe")
    wire.use_pixel_size = True
    wire.inputs["Size"].default_value = 0.35
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (0.55, 0.55, 0.55, 1)
    mix.inputs["B"].default_value = (0.08, 0.12, 0.2, 1)
    nt.links.new(wire.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(m)


def render_one(glb, prefix):
    sc = reset()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    lo, hi = bounds(objs)
    real = hi - lo
    s = 1.0 / max(real)
    root = bpy.data.objects.new("root", None)
    sc.collection.objects.link(root)
    for o in [o for o in bpy.data.objects if o.parent is None and o is not root]:
        o.parent = root
    c = (lo + hi) / 2
    root.scale = (s, s, s)
    root.location = (-c.x * s, -c.y * s, -lo.z * s)
    bpy.context.view_layer.update()
    lo, hi = bounds(objs)
    centre, radius = (lo + hi) / 2, (hi - lo).length / 2

    bpy.ops.mesh.primitive_plane_add(size=20)
    fm = bpy.data.materials.new("floor")
    fm.use_nodes = True
    fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.32, 0.33, 1)
    bpy.context.object.data.materials.append(fm)
    add_light("key", (2.2, -2.6, 3.0), 260, 1.6)
    add_light("fill", (-3.0, -1.5, 1.6), 70, 2.5, (0.85, 0.9, 1.0))
    add_light("rim", (-1.0, 3.0, 2.5), 160, 1.2)

    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 70
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    dist = radius / math.sin(cam_d.angle / 2) * 1.02

    def shoot(az_deg, el_deg, path):
        # az 0 looks at the model from −Y, i.e. at its front once prepared.
        az, el = math.radians(az_deg), math.radians(el_deg)
        d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
        cam.location = centre + d * dist
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)

    shoot(-30, 18, prefix + "_beauty.png")
    shoot(150, 22, prefix + "_back.png")
    clay(objs)
    shoot(-30, 18, prefix + "_clay.png")
    tris = 0
    for o in objs:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    return {"tris": tris, "size_m": [round(v, 3) for v in real]}


stats = {}
for cand in job["candidates"]:
    prefix = os.path.join(OUT, cand["name"])
    try:
        stats[cand["name"]] = render_one(cand["glb"], prefix)
        print("COMPARE_OK", cand["name"], flush=True)
    except Exception as e:  # a broken model is itself a result
        stats[cand["name"]] = {"error": repr(e)}
        print("COMPARE_FAILED", cand["name"], e, flush=True)
json.dump(stats, open(os.path.join(OUT, "stats.json"), "w"), indent=2)
print("COMPARE_DONE", OUT)
