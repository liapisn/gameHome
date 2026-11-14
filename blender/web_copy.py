"""
A lighter copy of a room model for the browser: dense meshes reduced, textures capped, Draco.
The full-detail room.glb stays as built; this is what the tour viewer loads.

    blender -b --factory-startup -P blender/web_copy.py -- <job.json>

Job: { "glb": "<room .glb>", "out": "<web .glb>", "maxTris": 60000, "maxTex": 1024 }
"""
import json
import os
import sys

import bpy

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))
MAX_TRIS = job.get("maxTris", 60000)
MAX_TEX = job.get("maxTex", 1024)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=job["glb"])

# Linked copies share one mesh: reduce each mesh once.
done = set()
before = after = 0
for o in bpy.data.objects:
    if o.type != "MESH" or o.data.name in done:
        continue
    done.add(o.data.name)
    o.data.calc_loop_triangles()
    tris = len(o.data.loop_triangles)
    before += tris
    if tris > MAX_TRIS:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new("web", "DECIMATE")
        m.ratio = MAX_TRIS / tris
        # Applying a modifier on a shared mesh needs a single user; apply via evaluated copy instead.
        dg = bpy.context.evaluated_depsgraph_get()
        new_mesh = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        users = [x for x in bpy.data.objects if x.data == o.data]
        for x in users:
            x.modifiers.clear()
            x.data = new_mesh
        tris = len(new_mesh.polygons)
    after += tris

for img in bpy.data.images:
    if img.size[0] and max(img.size) > MAX_TEX:
        f = MAX_TEX / max(img.size)
        img.scale(max(1, int(img.size[0] * f)), max(1, int(img.size[1] * f)))
        img.pack()

bpy.ops.export_scene.gltf(
    filepath=job["out"],
    export_apply=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_image_format="JPEG",
    export_jpeg_quality=82,
    export_extras=True,
)
print("WEB_COPY_OK", job["out"], f"{before} -> {after} tris", f"{os.path.getsize(job['out']) / 1e6:.1f} MB")
