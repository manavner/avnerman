"""
Salsa sunset silhouette scene for Blender (4.2 and newer, tested on 5.0).

What it does
------------
Imports two Mixamo FBX files (man + woman), places them facing each other,
turns them into black silhouettes and builds a sunset scene around them:
gradient sky, setting sun, sea, a dark pier, a camera and render settings
for a 1920x1080 / 30 fps MP4.

How to use
----------
1. In Blender open the "Scripting" tab (top bar).
2. Click "Open" and choose this file (salsa_scene.py).
3. Fill in MAN_FBX and WOMAN_FBX below with the full paths to your files.
4. Click "Run Script" (the triangle button) or press Alt+P.
5. Press Numpad 0 to look through the camera, then F12 for a still frame
   or Render > Render Animation (Ctrl+F12) to render the video.

Leave the two paths empty to use characters you already imported yourself
(File > Import > FBX): the script then uses the first two armatures it finds.
"""
import math
import os

import bpy

# ------------------------------------------------------------------ settings
MAN_FBX = r""        # e.g. r"C:\Users\Avner\Downloads\man_salsa.fbx"
WOMAN_FBX = r""      # e.g. r"C:\Users\Avner\Downloads\woman_salsa.fbx"

SEPARATION = 0.9     # distance between the two dancers, meters
MAN_TURN = 90        # degrees; Mixamo characters face -Y, +90 turns to face +X
WOMAN_TURN = -90     # if they end up back to back, swap these two signs
FPS = 30
RESOLUTION = (1920, 1080)
ENGINE = "EEVEE"     # "EEVEE" (fast) or "CYCLES" (slower, higher quality)
OUTPUT = "//salsa_blender.mp4"   # "//" means next to the saved .blend file

PREFIX = "SALSA_"


# ------------------------------------------------------------------- helpers
def srgb(hex_color, alpha=1.0):
    """'#ff8c00' -> linear RGBA tuple (Blender shaders work in linear color)."""
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


def remove_previous_run(drop_characters):
    """Delete what an earlier run created. Characters it imported go too when we re-import."""
    for ob in list(bpy.data.objects):
        if ob.name in bpy.data.objects and ob.name.startswith(PREFIX):
            doomed = [ob]
            if drop_characters and ob.name in (PREFIX + "Man", PREFIX + "Woman"):
                doomed += list(ob.children_recursive)
            for d in doomed:
                bpy.data.objects.remove(d, do_unlink=True)
    for ob in list(bpy.data.objects):          # Blender's default cube/light/camera
        if ob.name in ("Cube", "Light", "Camera"):
            bpy.data.objects.remove(ob, do_unlink=True)


def import_fbx(path):
    path = bpy.path.abspath(path)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"FBX file not found: {path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=True)
    new = [ob for ob in bpy.data.objects if ob not in before]
    arms = [ob for ob in new if ob.type == "ARMATURE"]
    if not arms:
        raise RuntimeError(f"No armature found in {path} - was it exported 'With Skin'?")
    return arms[0]


def find_armatures():
    arms = [ob for ob in bpy.data.objects
            if ob.type == "ARMATURE" and not (ob.parent and ob.parent.name.startswith(PREFIX))]
    arms += [ob for ob in bpy.data.objects
             if ob.type == "ARMATURE" and ob.parent and ob.parent.name.startswith(PREFIX)]
    if len(arms) < 2:
        raise RuntimeError("Need two characters: set MAN_FBX and WOMAN_FBX, "
                           "or import two Mixamo FBX files first (File > Import > FBX).")
    return arms[0], arms[1]


def character_meshes(arm):
    return [ob for ob in bpy.data.objects
            if ob.type == "MESH" and (ob.parent == arm or
                                      any(m.type == "ARMATURE" and m.object == arm for m in ob.modifiers))]


def place(arm, x, turn_deg, name):
    """Parent the armature to an empty so we never touch Mixamo's own transform."""
    root = bpy.data.objects.new(PREFIX + name, None)
    bpy.context.scene.collection.objects.link(root)
    root.empty_display_size = 0.3
    if arm.parent and arm.parent.name.startswith(PREFIX):
        old = arm.parent
        mw = arm.matrix_world.copy()
        arm.parent = None
        arm.matrix_world = old.matrix_world.inverted() @ mw
        bpy.data.objects.remove(old, do_unlink=True)
    arm.parent = root
    root.location = (x, 0.0, 0.0)
    root.rotation_euler = (0.0, 0.0, math.radians(turn_deg))


def emission_material(name, color, strength=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    em.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def gradient_material(name, stops):
    """Emission colored by the vertical screen position (0 = bottom, 1 = top)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    set_ramp(ramp.color_ramp, stops)
    nt.links.new(tc.outputs["Window"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def set_ramp(ramp, stops):
    els = ramp.elements
    while len(els) > 1:
        els.remove(els[-1])
    els[0].position, els[0].color = stops[0][0], srgb(stops[0][1])
    for pos, col in stops[1:]:
        e = els.new(pos)
        e.color = srgb(col)


def add_mesh(name, mesh_op, material, **kwargs):
    mesh_op(**kwargs)
    ob = bpy.context.active_object
    ob.name = PREFIX + name
    ob.data.materials.clear()
    ob.data.materials.append(material)
    return ob


def action_end(arm):
    ad = arm.animation_data
    if ad and ad.action:
        return int(math.ceil(ad.action.frame_range[1]))
    return 0


# ---------------------------------------------------------------- the scene
def build():
    scene = bpy.context.scene
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    remove_previous_run(drop_characters=bool(MAN_FBX and WOMAN_FBX))

    if MAN_FBX and WOMAN_FBX:
        man, woman = import_fbx(MAN_FBX), import_fbx(WOMAN_FBX)
    else:
        man, woman = find_armatures()

    place(man, -SEPARATION / 2, MAN_TURN, "Man")
    place(woman, SEPARATION / 2, WOMAN_TURN, "Woman")

    # silhouettes: every material slot of both characters becomes flat black
    ink = emission_material(PREFIX + "Silhouette", srgb("#0e0612"))
    meshes = character_meshes(man) + character_meshes(woman)
    for ob in meshes:
        for slot in ob.material_slots:
            slot.material = ink
        if not ob.material_slots:
            ob.data.materials.append(ink)

    # height of the characters, used to frame the camera
    bpy.context.view_layer.update()
    tallest = max((ob.dimensions.z for ob in meshes), default=1.8)
    if not 0.5 < tallest < 5:
        tallest = 1.8

    # sky
    world = scene.world or bpy.data.worlds.new(PREFIX + "World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    set_ramp(ramp.color_ramp, [(0.45, "#ffc072"), (0.56, "#f88a4c"), (0.70, "#d9506a"),
                               (0.84, "#7a2470"), (1.0, "#1c0b34")])
    nt.links.new(tc.outputs["Window"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    # camera: horizon in the middle of the frame, dancers filling ~60% of the height
    view_h = tallest * 1.65
    cam_z = view_h * 0.32
    cam_data = bpy.data.cameras.new(PREFIX + "Camera")
    cam_data.lens = 50
    cam_data.sensor_width = 36
    half_fov_v = math.atan((36 * RESOLUTION[1] / RESOLUTION[0]) / 2 / 50)
    dist = (view_h / 2) / math.tan(half_fov_v)
    cam = bpy.data.objects.new(PREFIX + "Camera", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0.0, -dist, cam_z)
    cam.rotation_euler = (math.radians(90), 0.0, 0.0)
    scene.camera = cam

    # sun disk sitting on the horizon, far behind the dancers
    sun_dist = 150.0
    sun_r = 0.085 * sun_dist
    sun = add_mesh("Sun", bpy.ops.mesh.primitive_circle_add,
                   emission_material(PREFIX + "SunMat", srgb("#ffe08f")),
                   vertices=96, radius=sun_r, fill_type="NGON",
                   location=(0.0, sun_dist, sun_r * 0.55), rotation=(math.radians(90), 0, 0))
    glow = add_mesh("SunGlow", bpy.ops.mesh.primitive_circle_add,
                    emission_material(PREFIX + "GlowMat", srgb("#ffb066")),
                    vertices=96, radius=sun_r * 1.12, fill_type="NGON",
                    location=(0.0, sun_dist + 1, sun_r * 0.55), rotation=(math.radians(90), 0, 0))

    # sea (a little below the pier so the pier edge reads as a line)
    add_mesh("Sea", bpy.ops.mesh.primitive_plane_add,
             gradient_material(PREFIX + "SeaMat", [(0.0, "#3a1440"), (0.30, "#7a2a5c"),
                                                   (0.47, "#e8806a"), (0.5, "#f5a070")]),
             size=600, location=(0.0, 300.0, -0.25))

    # dark pier the dancers stand on
    pier = add_mesh("Pier", bpy.ops.mesh.primitive_cube_add, ink,
                    size=1, location=(0.0, -dist / 2 + 0.6, -0.5))
    pier.scale = (40.0, dist + 1.2, 1.0)

    # render settings
    for eng in (["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"] if ENGINE == "EEVEE" else ["CYCLES"]):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 64
    scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
    scene.render.resolution_percentage = 100
    scene.render.fps = FPS
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    end = max(action_end(man), action_end(woman))
    if end > 1:
        scene.frame_start, scene.frame_end = 1, end
    scene.frame_set(scene.frame_start)

    img = scene.render.image_settings
    if hasattr(img, "media_type"):          # Blender 5.0+
        img.media_type = "VIDEO"
    img.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    # "//" only works once the .blend file is saved; otherwise write to the home folder
    scene.render.filepath = OUTPUT if bpy.data.filepath or not OUTPUT.startswith("//") \
        else os.path.join(os.path.expanduser("~"), OUTPUT[2:])

    print(f"[salsa] ready: frames {scene.frame_start}-{scene.frame_end}, "
          f"character height {tallest:.2f} m, camera distance {dist:.1f} m, "
          f"video -> {bpy.path.abspath(scene.render.filepath)}")


build()
