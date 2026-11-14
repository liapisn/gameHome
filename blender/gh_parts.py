"""
gh_parts: tested building blocks for furniture written as Blender code (docs/boxd-models-plan.md, part 2).

Model-written `build(gh, size)` functions compose these instead of raw bpy. Written for Blender 5.3.

Frame and units, everywhere:
  - metres; Z up; the object's front faces -Y (the viewer looks at it from -Y);
  - `at=(x, y, z)` is where the shape's footprint centre sits, at the shape's BOTTOM (z is the
    height of its lowest point). So `box((1, .5, .8), at=(0, 0, 0))` stands on the floor.
  - `rot=(rx, ry, rz)` in degrees, about the shape's own `at` point, applied X then Y then Z.
  - every shape takes `mat` (a material from the functions below, or None) and `name`, and returns
    the new object.

Materials are plain Principled BSDF values (colour, roughness, metal, transmission): exactly what a
.glb keeps, so what the renders show is what the web viewer shows. Colours are "#rrggbb" or (r, g, b)
in 0..1 sRGB.
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

__all__ = [
    # shapes
    "box", "rounded_box", "cylinder", "cone", "sphere", "tube", "panel", "slab_top", "leg", "leg_set",
    "cushion", "pillow", "door_front", "drawer_front", "handle", "shelf_unit", "frame", "mattress",
    "lampshade", "plant_pot", "foliage",
    # operations
    "mirror_x", "array", "bevel", "smooth", "join", "move", "rotate",
    # materials
    "wood", "painted", "fabric", "leather", "metal", "chrome", "glass", "ceramic", "stone", "plastic",
    "rattan", "emissive",
]

# --------------------------------------------------------------------------- internals


def _link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _mesh_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return _link(bpy.data.objects.new(name, me))


def _place(obj, at, rot):
    obj.location = Vector(at)
    if rot:
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = Euler([math.radians(a) for a in rot], "XYZ")
    return obj


def _assign(obj, mat):
    if mat is not None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def _box_bm(w, d, h):
    """A w×d×h box with its bottom face centred on the origin."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(w, d, h), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts)
    return bm


def _cone_bm(r1, r2, h, segments):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r1, radius2=r2, depth=h)
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts)
    return bm


def _apply_modifiers(obj):
    """Bake the modifier stack into the mesh (joins and exports then see the final shape)."""
    if obj.type == "MESH" and not obj.modifiers:
        return obj
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    if obj.type == "MESH":
        old = obj.data
        obj.modifiers.clear()
        obj.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return obj
    # A curve or other non-mesh: replace it with a mesh object in the same place.
    new = _link(bpy.data.objects.new(obj.name, me))
    new.matrix_world = obj.matrix_world.copy()
    bpy.data.objects.remove(obj, do_unlink=True)
    return new


def _shade(obj, angle_deg=35.0):
    """Smooth shading with hard edges above `angle_deg` (flat faces stay flat)."""
    me = obj.data
    me.shade_smooth()
    try:
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    except Exception:
        pass
    return obj


def _bevel_mod(obj, width, segments=3):
    if width <= 0:
        return obj
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(30)
    m.use_clamp_overlap = True
    return obj


# --------------------------------------------------------------------------- shapes


def box(size, at=(0, 0, 0), mat=None, rot=None, name="box"):
    """A box of size (w, d, h)."""
    w, d, h = size
    return _assign(_place(_mesh_object(name, _box_bm(w, d, h)), at, rot), mat)


def rounded_box(size, radius=0.01, at=(0, 0, 0), mat=None, rot=None, name="rounded_box", segments=3):
    """A box with rounded edges (`radius` in metres, clamped to half the smallest side)."""
    w, d, h = size
    obj = box(size, at, mat, rot, name)
    _bevel_mod(obj, min(radius, min(w, d, h) / 2 * 0.98), segments)
    _apply_modifiers(obj)
    return _shade(obj)


def cylinder(radius, height, at=(0, 0, 0), mat=None, rot=None, name="cylinder", segments=32):
    """An upright cylinder (lay it down with rot=(90, 0, 0) or (0, 90, 0))."""
    obj = _place(_mesh_object(name, _cone_bm(radius, radius, height, segments)), at, rot)
    return _shade(_assign(obj, mat))


def cone(radius_bottom, radius_top, height, at=(0, 0, 0), mat=None, rot=None, name="cone", segments=32):
    """A truncated cone (radius_top=0 for a point)."""
    obj = _place(_mesh_object(name, _cone_bm(radius_bottom, radius_top, height, segments)), at, rot)
    return _shade(_assign(obj, mat))


def sphere(radius, at=(0, 0, 0), mat=None, rot=None, name="sphere", segments=32, squash=1.0):
    """A sphere resting on `at`; `squash` < 1 flattens it vertically (an ellipsoid)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=max(8, segments // 2), radius=radius)
    bmesh.ops.scale(bm, vec=(1, 1, squash), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, radius * squash), verts=bm.verts)
    obj = _place(_mesh_object(name, bm), at, rot)
    obj.data.shade_smooth()
    return _assign(obj, mat)


def tube(path, radius, mat=None, name="tube", closed=False, segments=12):
    """A round bar along `path`, a list of (x, y, z) points in object space (no `at`: the points are
    where they are). For bent frames, rails, lamp arms, chair hoops."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = max(1, segments // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(path) - 1)
    for p, xyz in zip(sp.points, path):
        p.co = (xyz[0], xyz[1], xyz[2], 1)
    sp.use_cyclic_u = closed
    obj = _link(bpy.data.objects.new(name, cu))
    obj = _apply_modifiers(obj)
    obj.name = name
    return _shade(_assign(obj, mat))


def panel(w, h, t=0.018, at=(0, 0, 0), mat=None, rot=None, name="panel"):
    """An upright board facing -Y: w wide, h tall, t thick (centred on `at` in depth)."""
    return box((w, t, h), at, mat, rot, name)


def slab_top(w, d, t=0.03, overhang=0.0, edge_radius=0.0, at=(0, 0, 0), mat=None, rot=None, name="top"):
    """A table or counter top: w×d plus `overhang` on every side, t thick, bottom at `at`."""
    size = (w + 2 * overhang, d + 2 * overhang, t)
    if edge_radius > 0:
        return rounded_box(size, edge_radius, at, mat, rot, name)
    return box(size, at, mat, rot, name)


def leg(height, top=0.04, bottom=None, shape="square", at=(0, 0, 0), mat=None, rot=None, name="leg"):
    """A leg `height` tall, `top` wide at the top and `bottom` wide at the floor (tapered if they
    differ). shape: "square" or "round"."""
    bottom = top if bottom is None else bottom
    if shape == "round":
        return cone(bottom / 2, top / 2, height, at, mat, rot, name, segments=20)
    # A 4-sided cone rotated 45° is a square-section leg; its radius is half the diagonal.
    k = math.sqrt(2) / 2
    bm = _cone_bm(bottom * k, top * k, height, 4)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(45), 3, "Z"))
    return _assign(_place(_mesh_object(name, bm), at, rot), mat)


def leg_set(w, d, height, inset=0.04, top=0.04, bottom=None, shape="square", z=0.0, mat=None, name="leg"):
    """Four legs under a w×d footprint centred on the origin, each `inset` in from the corners
    (measured to the leg's centre). Returns the four legs."""
    xs = (-w / 2 + inset, w / 2 - inset)
    ys = (-d / 2 + inset, d / 2 - inset)
    return [leg(height, top, bottom, shape, (x, y, z), mat, None, f"{name}_{i}") for i, (x, y) in enumerate((a, b) for a in xs for b in ys)]


def cushion(w, d, h, puff=0.5, at=(0, 0, 0), mat=None, rot=None, name="cushion"):
    """A seat or back cushion: a soft box, w×d×h, `puff` 0 (crisp) to 1 (very rounded and domed)."""
    puff = max(0.0, min(1.0, puff))
    obj = box((w, d, h), at, mat, rot, name)
    _bevel_mod(obj, min(w, d, h) * (0.12 + 0.3 * puff), segments=4)
    sub = obj.modifiers.new("soft", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    if puff > 0:
        # Dome the top and bottom faces a little, as a stuffed cushion bulges.
        cast = obj.modifiers.new("puff", "CAST")
        cast.cast_type = "SPHERE"
        cast.factor = 0.12 * puff
        cast.use_x = cast.use_y = False
        cast.use_z = True
    _apply_modifiers(obj)
    obj.data.shade_smooth()
    # Casting can lift the bottom off z=0: put it back on `at`.
    lowest = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    obj.location.z += at[2] - lowest
    return obj


def pillow(w, h, t=0.14, at=(0, 0, 0), mat=None, rot=None, name="pillow"):
    """A throw or bed pillow standing upright, facing -Y: w wide, h tall, t thick."""
    return cushion(w, t, h, 0.9, at, mat, rot, name)


def handle(kind="bar", length=0.16, at=(0, 0, 0), mat=None, vertical=True, name="handle"):
    """A handle whose base sits at `at` on a front face and sticks out towards -Y.
    kind: "bar" (a rod on two posts), "knob", "edge" (a thin lip along the top) or "none"."""
    x, y, z = at
    parts = []
    if kind == "none":
        return None
    if kind == "knob":
        parts.append(cylinder(0.006, 0.02, (x, y, z), mat, (90, 0, 0), name + "_post", 12))
        parts.append(sphere(0.014, (x, y - 0.02 - 0.014, z - 0.014), mat, None, name + "_knob", 16))
    elif kind == "edge":
        size = (length, 0.012, 0.012) if not vertical else (0.012, 0.012, length)
        parts.append(box(size, (x, y - 0.006, z - (size[2] / 2)), mat, None, name))
    else:  # bar
        stand = 0.03
        r = 0.006
        ends = [(0, length / 2), (0, -length / 2)] if vertical else [(length / 2, 0), (-length / 2, 0)]
        for i, (dx, dz) in enumerate(ends):
            parts.append(cylinder(r, stand, (x + dx, y, z + dz), mat, (90, 0, 0), f"{name}_post{i}", 12))
        if vertical:
            parts.append(cylinder(r, length + 2 * r, (x, y - stand, z - length / 2 - r), mat, None, name + "_bar", 12))
        else:
            parts.append(cylinder(r, length + 2 * r, (x - length / 2 - r, y - stand, z), mat, (0, 90, 0), name + "_bar", 12))
    return join(parts, name)


def door_front(w, h, style="flat", handle_kind="bar", t=0.019, at=(0, 0, 0), mat=None, handle_mat=None, glass_mat=None, hinge="left", name="door"):
    """A cabinet door facing -Y, w×h, t thick, bottom-centre at `at`.
    style: "flat", "shaker" (raised frame) or "glass" (frame around a glass pane).
    The handle sits on the side away from the hinge, vertical, a third of the way down."""
    x, y, z = at
    parts = []
    rail = min(0.07, w * 0.18, h * 0.18)
    if style == "flat":
        parts.append(rounded_box((w, t, h), 0.002, (x, y, z), mat, None, name + "_panel"))
    else:
        inner = t * 0.5 if style == "shaker" else 0.0
        # Frame: two stiles, two rails.
        parts.append(box((rail, t, h), (x - w / 2 + rail / 2, y, z), mat, None, name + "_stileL"))
        parts.append(box((rail, t, h), (x + w / 2 - rail / 2, y, z), mat, None, name + "_stileR"))
        parts.append(box((w - 2 * rail, t, rail), (x, y, z), mat, None, name + "_railB"))
        parts.append(box((w - 2 * rail, t, rail), (x, y, z + h - rail), mat, None, name + "_railT"))
        if style == "shaker":
            parts.append(box((w - 2 * rail, inner, h - 2 * rail), (x, y + (t - inner) / 2, z + rail), mat, None, name + "_inset"))
        else:
            pane = box((w - 2 * rail, 0.006, h - 2 * rail), (x, y, z + rail), glass_mat or glass(), None, name + "_glass")
            parts.append(pane)
    door = join(parts, name)
    side = 1 if hinge == "left" else -1
    hx = x + side * (w / 2 - max(rail, 0.04) / 2 - 0.01)
    hz = z + h * (0.62 if h > 0.5 else 0.5)
    hd = handle(handle_kind, min(0.16, h * 0.3), (hx, y - t / 2, hz), handle_mat or chrome(), True, name + "_handle")
    return join([door, hd], name) if hd else door


def drawer_front(w, h, handle_kind="bar", t=0.019, at=(0, 0, 0), mat=None, handle_mat=None, name="drawer"):
    """A drawer front facing -Y with a horizontal handle centred near its top."""
    x, y, z = at
    front = rounded_box((w, t, h), 0.002, (x, y, z), mat, None, name + "_front")
    hd = handle(handle_kind, min(0.2, w * 0.4), (x, y - t / 2, z + h * 0.6), handle_mat or chrome(), False, name + "_handle")
    return join([front, hd], name) if hd else front


def shelf_unit(w, d, h, shelves=3, back=True, t=0.018, at=(0, 0, 0), mat=None, back_mat=None, name="shelves"):
    """An open shelf case: two sides, top, bottom, `shelves` evenly spaced shelves between, and an
    optional back panel. Open side faces -Y."""
    x, y, z = at
    parts = [
        box((t, d, h), (x - w / 2 + t / 2, y, z), mat, None, name + "_sideL"),
        box((t, d, h), (x + w / 2 - t / 2, y, z), mat, None, name + "_sideR"),
        box((w - 2 * t, d, t), (x, y, z), mat, None, name + "_bottom"),
        box((w - 2 * t, d, t), (x, y, z + h - t), mat, None, name + "_top"),
    ]
    gap = (h - 2 * t) / (shelves + 1)
    for i in range(shelves):
        parts.append(box((w - 2 * t, d - (0.01 if back else 0), t), (x, y - (0.005 if back else 0), z + t + gap * (i + 1) - t / 2), mat, None, f"{name}_shelf{i}"))
    if back:
        parts.append(box((w - 2 * t, 0.006, h - 2 * t), (x, y + d / 2 - 0.003, z + t), back_mat or mat, None, name + "_back"))
    return join(parts, name)


def frame(w, h, bar=0.04, depth=None, at=(0, 0, 0), mat=None, rot=None, name="frame"):
    """An open rectangular frame standing in the XZ plane (facing -Y): w wide, h tall, square bars
    `bar` wide and `depth` deep (default = bar). Bed ends, chair backs, mirror frames, railings."""
    depth = bar if depth is None else depth
    x, y, z = at
    parts = [
        box((bar, depth, h), (x - w / 2 + bar / 2, y, z), mat, None, name + "_L"),
        box((bar, depth, h), (x + w / 2 - bar / 2, y, z), mat, None, name + "_R"),
        box((w - 2 * bar, depth, bar), (x, y, z), mat, None, name + "_B"),
        box((w - 2 * bar, depth, bar), (x, y, z + h - bar), mat, None, name + "_T"),
    ]
    return _place(join(parts, name), at, rot)


def mattress(w, d, h=0.22, at=(0, 0, 0), mat=None, name="mattress"):
    """A mattress: a box with softly rounded edges."""
    return cushion(w, d, h, 0.25, at, mat, None, name)


def lampshade(radius_bottom, radius_top, height, at=(0, 0, 0), mat=None, name="lampshade", thickness=0.004):
    """An open drum or cone shade (no top or bottom cap)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=40, radius1=radius_bottom, radius2=radius_top, depth=height)
    bmesh.ops.translate(bm, vec=(0, 0, height / 2), verts=bm.verts)
    obj = _mesh_object(name, bm)
    sol = obj.modifiers.new("thick", "SOLIDIFY")
    sol.thickness = thickness
    _apply_modifiers(obj)
    obj.data.shade_smooth()
    return _assign(_place(obj, at, None), mat)


def plant_pot(radius, height, at=(0, 0, 0), mat=None, soil_mat=None, name="pot", taper=0.8):
    """A pot, `radius` at the rim narrowing to radius×taper at the base, with soil just below the rim."""
    x, y, z = at
    body = cone(radius * taper, radius, height, (x, y, z), mat, None, name + "_body", 32)
    soil = cylinder(radius * 0.94, 0.01, (x, y, z + height - 0.03), soil_mat or _mat("soil", "#3b2a1e", 1.0), None, name + "_soil", 32)
    return join([body, soil], name)


def foliage(radius=0.3, height=0.6, density=1.0, at=(0, 0, 0), mat=None, stem_mat=None, seed=0, leaf=0.09, name="foliage"):
    """A leafy plant: stems from `at` up to `height`, carrying leaf cards in a crown of `radius`.
    `density` scales the leaf count (1 = about 120 leaves). Sits on `at` (put it on a pot's soil)."""
    rnd = random.Random(seed)
    x0, y0, z0 = at
    leaf_mat = mat or _mat("leaf", "#3f6b35", 0.6)
    stems, leaves = [], bmesh.new()
    n_stems = max(3, int(7 * density))
    for s in range(n_stems):
        a = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(0.2, 1.0) * radius
        top = (x0 + math.cos(a) * r, y0 + math.sin(a) * r, z0 + height * rnd.uniform(0.6, 1.0))
        mid = (x0 + math.cos(a) * r * 0.3, y0 + math.sin(a) * r * 0.3, z0 + (top[2] - z0) * 0.5)
        stems.append(tube([(x0, y0, z0), mid, top], 0.004, stem_mat or _mat("stem", "#4d5e2c", 0.7), f"{name}_stem{s}", segments=6))
    for _ in range(int(120 * density)):
        # A leaf: a diamond-shaped card, randomly tilted, in the upper part of the crown.
        a = rnd.uniform(0, 2 * math.pi)
        r = radius * math.sqrt(rnd.uniform(0.05, 1.0))
        c = Vector((x0 + math.cos(a) * r, y0 + math.sin(a) * r, z0 + height * rnd.uniform(0.35, 1.0)))
        L = leaf * rnd.uniform(0.7, 1.3)
        rotm = Euler((rnd.uniform(-1.2, 1.2), rnd.uniform(-1.2, 1.2), a)).to_matrix()
        pts = [Vector((0, -L / 2, 0)), Vector((L * 0.22, 0, 0)), Vector((0, L / 2, 0)), Vector((-L * 0.22, 0, 0))]
        vs = [leaves.verts.new(c + rotm @ p) for p in pts]
        leaves.faces.new(vs)
    leaf_obj = _assign(_mesh_object(name + "_leaves", leaves), leaf_mat)
    sol = leaf_obj.modifiers.new("thick", "SOLIDIFY")
    sol.thickness = 0.002
    _apply_modifiers(leaf_obj)
    return join(stems + [leaf_obj], name)


# --------------------------------------------------------------------------- operations


def move(obj, dx=0.0, dy=0.0, dz=0.0):
    """Shift an object by (dx, dy, dz) metres. Returns it."""
    obj.location += Vector((dx, dy, dz))
    return obj


def rotate(obj, degrees, axis="Z"):
    """Turn an object about its own origin by `degrees` around `axis`. Returns it."""
    obj.rotation_mode = "XYZ"
    e = obj.rotation_euler.copy()
    i = "XYZ".index(axis.upper())
    e[i] += math.radians(degrees)
    obj.rotation_euler = e
    return obj


def mirror_x(obj, name=None):
    """A copy of `obj` mirrored across the X=0 plane (left part → right part). Returns the copy."""
    _apply_modifiers(obj)
    new = obj.copy()
    new.data = obj.data.copy()
    new.name = name or obj.name + "_mirror"
    _link(new)
    bpy.context.view_layer.update()
    mw = Matrix.Scale(-1, 4, (1, 0, 0)) @ obj.matrix_world
    new.matrix_world = Matrix.Identity(4)
    new.data.transform(mw)
    new.data.flip_normals()
    new.data.update()
    return _origin_to_base(new)


def array(obj, count, offset):
    """`count` copies in a row, including `obj` itself, each `offset` = (dx, dy, dz) from the last.
    Returns the list of objects."""
    _apply_modifiers(obj)
    out = [obj]
    for i in range(1, count):
        c = obj.copy()
        c.data = obj.data.copy()
        c.name = f"{obj.name}_{i}"
        _link(c)
        c.location = obj.location + Vector(offset) * i
        out.append(c)
    return out


def bevel(obj, width=0.005, segments=2):
    """Round off an object's sharp edges by `width` metres. Returns it."""
    _bevel_mod(obj, width, segments)
    _apply_modifiers(obj)
    return _shade(obj)


def smooth(obj, angle=35.0):
    """Smooth shading, keeping edges sharper than `angle` degrees hard. Returns it."""
    return _shade(obj, angle)


def _bake(obj):
    """Move the object's transform into its mesh, leaving it at the world origin unrotated."""
    bpy.context.view_layer.update()
    if obj.data.users > 1:
        obj.data = obj.data.copy()
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)
    return obj


def _origin_to_base(obj):
    """Put the origin at the footprint centre of the mesh, at its lowest point (the `at` convention)."""
    vs = [v.co for v in obj.data.vertices]
    if not vs:
        return obj
    p = Vector(((min(v.x for v in vs) + max(v.x for v in vs)) / 2, (min(v.y for v in vs) + max(v.y for v in vs)) / 2, min(v.z for v in vs)))
    obj.data.transform(Matrix.Translation(-p))
    obj.location = p
    return obj


def join(objs, name="part"):
    """Merge objects into one (materials kept per face). None entries are skipped. The result's
    origin is its footprint centre at its lowest point, so move() and rotate() act on it the way
    `at` and `rot` do. Returns it."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    objs = [_bake(_apply_modifiers(o)) for o in objs]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    objs[0].name = name
    return _origin_to_base(objs[0])


# --------------------------------------------------------------------------- materials

_MATS = {}


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _rgb(color):
    if isinstance(color, str):
        h = color.lstrip("#")
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        color = tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    r, g, b = color[:3]
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), 1.0)


def _mat(kind, color, roughness, metallic=0.0, transmission=0.0, alpha=1.0, sheen=0.0, coat=0.0, emission=0.0):
    key = (kind, str(color), round(roughness, 3), metallic, transmission, alpha, sheen, coat, emission)
    if key in _MATS and _MATS[key].name in bpy.data.materials:
        return _MATS[key]
    m = bpy.data.materials.new(f"{kind}_{str(color).lstrip('#')}")
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    rgba = _rgb(color)
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if transmission:
        bsdf.inputs["Transmission Weight"].default_value = transmission
        bsdf.inputs["IOR"].default_value = 1.45
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
    if emission:
        bsdf.inputs["Emission Color"].default_value = rgba
        bsdf.inputs["Emission Strength"].default_value = emission
    m.diffuse_color = rgba  # viewport and some exporters
    _MATS[key] = m
    return m


def wood(color="#a0764a", grain=0.5):
    """Wood: `grain` 0 (smooth lacquered) to 1 (open, matte)."""
    return _mat("wood", color, 0.35 + 0.35 * grain, coat=0.3 * (1 - grain))


def painted(color="#f2f0eb", gloss=0.3):
    """Painted or lacquered board (MDF fronts, painted frames): `gloss` 0 matte to 1 high-gloss."""
    return _mat("painted", color, 0.75 - 0.65 * gloss, coat=0.5 * gloss)


def fabric(color="#8a8f96", weave=0.5):
    """Upholstery fabric: `weave` 0 (smooth velvet) to 1 (coarse linen)."""
    return _mat("fabric", color, 0.8 + 0.18 * weave, sheen=0.6 * (1 - weave) + 0.2)


def leather(color="#5a3a26"):
    return _mat("leather", color, 0.45, coat=0.15)


def metal(color="#9a9a9a", brushed=0.5):
    """Coloured metal (steel, brass, black metal legs): `brushed` 0 polished to 1 satin."""
    return _mat("metal", color, 0.15 + 0.35 * brushed, metallic=1.0)


def chrome():
    return _mat("chrome", "#e8e8e8", 0.06, metallic=1.0)


def glass(tint="#eef4f2"):
    return _mat("glass", tint, 0.02, transmission=1.0, alpha=0.35)


def ceramic(color="#f4f2ee"):
    return _mat("ceramic", color, 0.12, coat=0.6)


def stone(color="#d9d6cf", veining=0.3):
    """Stone or marble counters and table tops: `veining` only roughens slightly (constant colour)."""
    return _mat("stone", color, 0.2 + 0.25 * veining, coat=0.3)


def plastic(color="#f0f0f0"):
    return _mat("plastic", color, 0.4)


def rattan(color="#c4a06a"):
    return _mat("rattan", color, 0.85)


def emissive(color="#fff3d6", strength=3.0):
    """A glowing surface: lamp bulbs, lit shades, screens."""
    return _mat("emissive", color, 0.5, emission=strength)
