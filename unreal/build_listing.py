"""
Build (and optionally render) a gameHome listing inside Unreal Engine 5.

Input: the .glb + .plan.json written by `npm run export:glb`. The script relies on the
naming contract in src/lib/dollhouse-geometry.ts:
    floor__<roomType>__<roomId>  ceiling__<roomId>  wall__<interior|exterior>__<wallId>  glass__<openingId>
All geometry is baked in world space, so every mesh is spawned at the origin.

What it produces under /Game/Listings/<listing>/:
    Meshes/          imported static meshes
    Materials/       master materials + one instance per surface preset
    L_<listing>      level: dollhouse geometry, sun/sky lighting, one point light per room
    Cameras          one CineCamera per room at eye height (in the level)
    LS_Walkthrough   level sequence: one slow panning shot per room
With GAMEHOME_RENDER=1 it also renders LS_Walkthrough through Movie Render Queue to PNG frames.

Configuration is read from environment variables, because passing argv through
-ExecutePythonScript is unreliable across engine versions. scripts/render-unreal.sh sets them.
    GAMEHOME_GLB               absolute path to <listing>.glb               (required)
    GAMEHOME_OUT               directory for rendered frames                 (default: next to the glb)
    GAMEHOME_RENDER            "1" to render after building                  (default: 0)
    GAMEHOME_QUIT              "1" to close the editor when done             (default: 0)
    GAMEHOME_SECONDS_PER_ROOM  shot length                                   (default: 6)
    GAMEHOME_RESOLUTION        WIDTHxHEIGHT                                  (default: 1920x1080)
"""

import json
import os
import re

import unreal

# --------------------------------------------------------------------------- config

GLB = os.environ.get("GAMEHOME_GLB", "")
if not GLB or not os.path.isfile(GLB):
    raise RuntimeError(f"GAMEHOME_GLB must point to an exported .glb (got {GLB!r})")

LISTING = re.sub(r"[^A-Za-z0-9_]", "_", os.path.splitext(os.path.basename(GLB))[0])
OUT_DIR = os.environ.get("GAMEHOME_OUT") or os.path.join(os.path.dirname(GLB), "renders")
RENDER = os.environ.get("GAMEHOME_RENDER") == "1"
QUIT = os.environ.get("GAMEHOME_QUIT") == "1"
SECONDS_PER_ROOM = float(os.environ.get("GAMEHOME_SECONDS_PER_ROOM", "6"))
RES_W, RES_H = (int(v) for v in os.environ.get("GAMEHOME_RESOLUTION", "1920x1080").lower().split("x"))
FPS = 30

ROOT = f"/Game/Listings/{LISTING}"
MESH_DIR = f"{ROOT}/Meshes"
MAT_DIR = f"{ROOT}/Materials"
MAP_PATH = f"{ROOT}/L_{LISTING}"
SEQ_NAME = "LS_Walkthrough"

plan_path = GLB[: -len(".glb")] + ".plan.json"
PLAN = json.load(open(plan_path)) if os.path.isfile(plan_path) else {}
CEILING_CM = float(PLAN.get("ceilingHeight", 2.7)) * 100.0
ROOM_NAMES = {re.sub(r"[^A-Za-z0-9_]", "_", r["id"]): r["name"] for r in PLAN.get("rooms", [])}

asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
eal = unreal.EditorAssetLibrary
mel = unreal.MaterialEditingLibrary
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def log(msg):
    unreal.log(f"[gameHome] {msg}")


def srgb(hex_color):
    """sRGB hex → linear LinearColor (material parameters are linear)."""
    h = hex_color.lstrip("#")
    c = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return unreal.LinearColor(lin[0], lin[1], lin[2], 1.0)


# Surface presets: plain colors for now; swap in textured materials per preset later.
PRESETS = {
    "floor_living": ("#b08a64", 0.55),  # oak
    "floor_dining": ("#b08a64", 0.55),
    "floor_office": ("#b08a64", 0.55),
    "floor_bedroom": ("#c4a27c", 0.6),  # lighter oak
    "floor_kitchen": ("#d9d4cb", 0.35),  # stone tile
    "floor_bathroom": ("#e4e2de", 0.25),  # glazed tile
    "floor_hallway": ("#cfc6b8", 0.4),
    "floor_storage": ("#cfc6b8", 0.6),
    "floor_stairs": ("#a98763", 0.55),
    "floor_balcony": ("#bdb3a5", 0.8),  # terrazzo / concrete
    "wall_interior": ("#f2efe9", 0.9),
    "wall_exterior": ("#ece6da", 0.85),
    "ceiling": ("#fbfaf7", 0.95),
}


def classify(mesh_name):
    """Mesh asset name → (kind, preset key, room id or None). Tolerates importer prefixes like SM_."""
    m = re.search(r"floor__([a-z]+)__(\w+)", mesh_name)
    if m:
        return "floor", f"floor_{m.group(1)}", m.group(2)
    m = re.search(r"ceiling__(\w+)", mesh_name)
    if m:
        return "ceiling", "ceiling", m.group(1)
    m = re.search(r"wall__(interior|exterior)__", mesh_name)
    if m:
        return "wall", f"wall_{m.group(1)}", None
    if "glass__" in mesh_name:
        return "glass", "glass", None
    return None, None, None


# --------------------------------------------------------------------------- materials


def ensure_master(name, translucent=False):
    path = f"{MAT_DIR}/{name}"
    if eal.does_asset_exist(path):
        return eal.load_asset(path)
    mat = asset_tools.create_asset(name, MAT_DIR, unreal.Material, unreal.MaterialFactoryNew())

    base = mel.create_material_expression(mat, unreal.MaterialExpressionVectorParameter, -400, -100)
    base.set_editor_property("parameter_name", "BaseColor")
    base.set_editor_property("default_value", unreal.LinearColor(0.8, 0.8, 0.8, 1.0))
    mel.connect_material_property(base, "", unreal.MaterialProperty.MP_BASE_COLOR)

    rough = mel.create_material_expression(mat, unreal.MaterialExpressionScalarParameter, -400, 150)
    rough.set_editor_property("parameter_name", "Roughness")
    rough.set_editor_property("default_value", 0.8)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)

    if translucent:
        mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
        opacity = mel.create_material_expression(mat, unreal.MaterialExpressionScalarParameter, -400, 300)
        opacity.set_editor_property("parameter_name", "Opacity")
        opacity.set_editor_property("default_value", 0.2)
        mel.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)

    mel.recompile_material(mat)
    eal.save_loaded_asset(mat)
    return mat


def ensure_instance(key, parent, color_hex, roughness):
    name = f"MI_{key}"
    path = f"{MAT_DIR}/{name}"
    if eal.does_asset_exist(path):
        mi = eal.load_asset(path)
    else:
        mi = asset_tools.create_asset(
            name, MAT_DIR, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew()
        )
    mel.set_material_instance_parent(mi, parent)
    mel.set_material_instance_vector_parameter_value(mi, "BaseColor", srgb(color_hex))
    mel.set_material_instance_scalar_parameter_value(mi, "Roughness", roughness)
    eal.save_loaded_asset(mi)
    return mi


def build_materials():
    opaque = ensure_master("M_GameHome_Opaque")
    glass = ensure_master("M_GameHome_Glass", translucent=True)
    mats = {k: ensure_instance(k, opaque, c, r) for k, (c, r) in PRESETS.items()}
    mats["glass"] = ensure_instance("glass", glass, "#cfe3ec", 0.05)
    return mats


# --------------------------------------------------------------------------- import


def import_meshes():
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", GLB)
    task.set_editor_property("destination_path", MESH_DIR)
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", True)
    asset_tools.import_asset_tasks([task])

    # Don't rely on imported_object_paths (Interchange fills it inconsistently); list the folder.
    meshes = []
    for path in eal.list_assets(MESH_DIR, recursive=True, include_folder=False):
        asset = eal.load_asset(path)
        if isinstance(asset, unreal.StaticMesh):
            meshes.append(asset)
    if not meshes:
        raise RuntimeError(f"No static meshes imported from {GLB}")
    log(f"imported {len(meshes)} static meshes")
    return meshes


# --------------------------------------------------------------------------- level


def spawn(cls, location=(0, 0, 0), rotation=(0, 0, 0), label=None, folder=None):
    """rotation is (pitch, yaw, roll) in degrees."""
    pitch, yaw, roll = rotation
    actor = actors.spawn_actor_from_class(
        cls, unreal.Vector(*location), unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)
    )
    if label:
        actor.set_actor_label(label)
    if folder:
        actor.set_folder_path(folder)
    return actor


def build_level(meshes, mats):
    if eal.does_asset_exist(MAP_PATH):
        eal.delete_asset(MAP_PATH)
    if not levels.new_level(MAP_PATH):
        raise RuntimeError(f"Could not create level {MAP_PATH}")

    floors = []  # (room_id, room_type, actor)
    unmatched = []
    for mesh in meshes:
        name = mesh.get_name()
        kind, preset, room_id = classify(name)
        actor = actors.spawn_actor_from_object(mesh, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0))
        actor.set_actor_label(name)
        actor.set_folder_path(f"Dollhouse/{(kind or 'other').capitalize()}")
        comp = actor.get_component_by_class(unreal.StaticMeshComponent)
        if preset in mats:
            for i in range(comp.get_num_materials()):
                comp.set_material(i, mats[preset])
        else:
            unmatched.append(name)
        if kind == "floor":
            floors.append((room_id, preset[len("floor_"):], actor))
    if unmatched:
        unreal.log_warning(f"[gameHome] no preset for: {', '.join(unmatched)}")
    if not floors:
        raise RuntimeError(
            "No floor__* meshes found. If the importer combined meshes, disable "
            "'Combine Static Meshes' in the Interchange glTF pipeline for this project."
        )

    # Sun + sky. Lumen picks these up for GI through the windows.
    sun = spawn(unreal.DirectionalLight, (0, 0, 1000), (-38, -55, 0), "Sun", "Lighting")
    sun_c = sun.get_component_by_class(unreal.DirectionalLightComponent)
    sun_c.set_editor_property("atmosphere_sun_light", True)
    sun_c.set_intensity(8.0)  # lux
    spawn(unreal.SkyAtmosphere, label="SkyAtmosphere", folder="Lighting")
    sky = spawn(unreal.SkyLight, (0, 0, 500), label="SkyLight", folder="Lighting")
    sky.get_component_by_class(unreal.SkyLightComponent).set_editor_property("real_time_capture", True)
    spawn(unreal.ExponentialHeightFog, label="HeightFog", folder="Lighting")
    ppv = spawn(unreal.PostProcessVolume, label="PostProcess", folder="Lighting")
    ppv.set_editor_property("unbound", True)

    # Rooms: a warm ceiling light and an eye-height camera each.
    rooms = []
    for room_id, room_type, floor in floors:
        origin, extent = floor.get_actor_bounds(False)
        floor_top = origin.z + extent.z
        label = ROOM_NAMES.get(room_id, room_id)

        if room_type != "balcony":
            lamp = spawn(
                unreal.PointLight, (origin.x, origin.y, floor_top + CEILING_CM - 30), label=f"Light {label}", folder="Lighting/Rooms"
            )
            lc = lamp.get_component_by_class(unreal.PointLightComponent)
            lc.set_editor_property("intensity_units", unreal.LightUnits.LUMENS)
            lc.set_intensity(1200.0)
            lc.set_editor_property("attenuation_radius", max(extent.x, extent.y) * 2.5)
            lc.set_editor_property("temperature", 3200.0)
            lc.set_editor_property("use_temperature", True)

        # Face along the room's longer axis; the sequence pans from there.
        yaw = 0.0 if extent.x >= extent.y else 90.0
        cam = spawn(
            unreal.CineCameraActor, (origin.x, origin.y, floor_top + 160), (-5, yaw, 0), f"Cam {label}", "Cameras"
        )
        cc = cam.get_cine_camera_component()
        cc.set_editor_property("current_focal_length", 14.0)
        focus = cc.get_editor_property("focus_settings")
        focus.set_editor_property("focus_method", unreal.CameraFocusMethod.DISABLE)
        cc.set_editor_property("focus_settings", focus)
        rooms.append((label, cam, yaw))

    levels.save_current_level()
    log(f"level {MAP_PATH}: {len(meshes)} meshes, {len(rooms)} rooms")
    return rooms


# --------------------------------------------------------------------------- sequence


def transform_channels(section):
    if hasattr(section, "get_all_channels"):
        return section.get_all_channels()
    return section.get_channels_by_type(unreal.MovieSceneScriptingDoubleChannel)


def camera_binding_id(seq, binding):
    try:  # UE 5.1+
        return unreal.MovieSceneSequenceExtensions.get_portable_binding_id(seq, seq, binding)
    except Exception:
        return seq.make_binding_id(binding, unreal.MovieSceneObjectBindingSpace.LOCAL)


def build_sequence(rooms):
    path = f"{ROOT}/{SEQ_NAME}"
    if eal.does_asset_exist(path):
        eal.delete_asset(path)
    seq = asset_tools.create_asset(SEQ_NAME, ROOT, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(FPS, 1))
    shot = int(SECONDS_PER_ROOM * FPS)
    seq.set_playback_start(0)
    seq.set_playback_end(shot * len(rooms))

    add_track = getattr(seq, "add_track", None) or seq.add_master_track  # add_master_track pre-5.2
    cuts = add_track(unreal.MovieSceneCameraCutTrack)

    for i, (label, cam, yaw) in enumerate(rooms):
        start, end = i * shot, (i + 1) * shot
        binding = seq.add_possessable(cam)

        section = binding.add_track(unreal.MovieScene3DTransformTrack).add_section()
        section.set_range(start, end)
        ch = transform_channels(section)  # loc x,y,z · rot roll,pitch,yaw · scale x,y,z
        loc = cam.get_actor_location()
        for idx, value in ((0, loc.x), (1, loc.y), (2, loc.z), (4, -5.0), (6, 1.0), (7, 1.0), (8, 1.0)):
            ch[idx].add_key(unreal.FrameNumber(start), value)
        ch[5].add_key(unreal.FrameNumber(start), yaw - 60.0)
        ch[5].add_key(unreal.FrameNumber(end), yaw + 60.0)

        cut = cuts.add_section()
        cut.set_range(start, end)
        cut.set_camera_binding_id(camera_binding_id(seq, binding))

    eal.save_loaded_asset(seq)
    log(f"sequence {path}: {len(rooms)} shots × {SECONDS_PER_ROOM}s")
    return seq


# --------------------------------------------------------------------------- render

_keepalive = []  # MRQ executors and tick handles must outlive this script's top-level scope


def render(seq):
    os.makedirs(OUT_DIR, exist_ok=True)
    mrq = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = mrq.get_queue()
    queue.delete_all_jobs()

    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.set_editor_property("job_name", LISTING)
    map_name = MAP_PATH.rsplit("/", 1)[1]
    job.set_editor_property("map", unreal.SoftObjectPath(f"{MAP_PATH}.{map_name}"))
    job.set_editor_property("sequence", unreal.SoftObjectPath(seq.get_path_name()))

    cfg = job.get_configuration()
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.set_editor_property("output_directory", unreal.DirectoryPath(OUT_DIR))
    out.set_editor_property("output_resolution", unreal.IntPoint(RES_W, RES_H))
    out.set_editor_property("file_name_format", "{sequence_name}.{frame_number}")
    aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    aa.set_editor_property("temporal_sample_count", 8)  # smooths Lumen noise on an M-series GPU
    aa.set_editor_property("override_anti_aliasing", True)
    aa.set_editor_property("anti_aliasing_method", unreal.AntiAliasingMethod.AAM_NONE)

    def on_finished(executor, success):
        log(f"render {'finished' if success else 'FAILED'} → {OUT_DIR}")
        if QUIT:
            unreal.SystemLibrary.quit_editor()

    executor = mrq.render_queue_with_executor(unreal.MoviePipelinePIEExecutor)
    executor.on_executor_finished_delegate.add_callable_unique(on_finished)
    _keepalive.append(executor)
    log(f"rendering {RES_W}x{RES_H} → {OUT_DIR}")


def main():
    log(f"building {LISTING} from {GLB}")
    if eal.does_directory_exist(ROOT):
        eal.delete_directory(ROOT)  # rebuild from scratch: the glb is the source of truth
    mats = build_materials()
    meshes = import_meshes()
    rooms = build_level(meshes, mats)
    seq = build_sequence(rooms)
    eal.save_directory(ROOT)

    if not RENDER:
        log("built (render skipped; set GAMEHOME_RENDER=1)")
        if QUIT:
            unreal.SystemLibrary.quit_editor()
        return

    # When launched with -ExecutePythonScript the editor is still starting up; MRQ's PIE
    # executor needs a ticking editor, so wait a few frames before queueing the render.
    state = {"ticks": 0}

    def tick(_dt):
        state["ticks"] += 1
        if state["ticks"] < 30:
            return
        unreal.unregister_slate_post_tick_callback(_keepalive.pop(0))
        render(seq)

    _keepalive.insert(0, unreal.register_slate_post_tick_callback(tick))


main()
