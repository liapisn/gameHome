"""
Join rooms into one house model: each floor's shell once, then every room's furniture, each moved
to its floor's height and plan offset.

    blender -b --factory-startup -P blender/join_house.py -- <job.json>

Job: { "levels": [{ "id", "shell": "<shell .glb>", "elevation": m, "offset": [ox, oy] }],
       "rooms": [{ "id", "glb": "<room .glb>", "level": "<level id>" }],
       "out": "<house .glb>" }
Plan (x, y, h) ↔ Blender (x, −y, h), as in build_scene.py.
"""
import json
import sys

import bpy
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
levels = {l["id"]: l for l in job["levels"]}


def bring(path, level, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    ox, oy = level.get("offset", [0, 0])
    root.location = Vector((ox, -oy, level.get("elevation", 0)))
    return len(new)


count = 0
for l in job["levels"]:
    if l.get("shell"):
        count += bring(l["shell"], l, f"shell-{l['id']}")
for r in job["rooms"]:
    count += bring(r["glb"], levels[r["level"]], f"room-{r['id']}")

bpy.ops.export_scene.gltf(filepath=job["out"], export_apply=True, export_draco_mesh_compression_enable=True, export_extras=True)
print("JOIN_HOUSE_OK", job["out"], count, "objects")
