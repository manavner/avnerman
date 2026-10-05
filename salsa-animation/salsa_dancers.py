#!/usr/bin/env python3
"""
Salsa silhouettes at sunset - a 15 second, 1920x1080 @ 30fps animation.

Two dancers (man with a fedora, woman with a flared skirt) dance a short
salsa routine in 5 bars of 8 counts (40 counts over 15 seconds):

  Bar 1  (counts  0-7)  basic step, closed hold
  Bar 2  (counts  8-15) basic step, opening to a one-hand hold
  Bar 3  (counts 16-23) woman's spin under the raised arm
  Bar 4  (counts 24-31) cross body lead - the partners swap sides
  Bar 5  (counts 32-39) half basic, then a dip and a final pose

The bodies are simple 3D skeletons (legs/arms solved with 2-bone IK) that
are projected from the side, so turns and spins look right in silhouette.

Usage:  python3 salsa_dancers.py [output.mp4] [--preview]
Needs:  numpy, pillow, ffmpeg on PATH.
"""
import math
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

W, H = 1920, 1080
FPS = 30
DURATION = 15.0
COUNTS = 40
BEAT = DURATION / COUNTS          # seconds per count (160 BPM)
SS = 2                            # supersampling for smooth silhouette edges
GROUND_Y = 905                    # screen y of the dance floor (pier edge)
HORIZON_Y = 760
CX = 960
INK = np.array([14, 6, 18], float)

UP = np.array([0.0, 1.0, 0.0])
DOWN = -UP


# ----------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smooth(u):
    u = clamp(u)
    return u * u * (3 - 2 * u)


def norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def fw2(th):
    return np.array([math.cos(th), math.sin(th)])


def sd2(th):
    return np.array([-math.sin(th), math.cos(th)])


def loc(B, th, x, z, h):
    """Local (forward x, side z) offset, in units of body height, to world XZ."""
    return np.asarray(B, float) + (x * fw2(th) + z * sd2(th)) * h


def proj(p):
    """3D world point -> supersampled screen point (side view, orthographic)."""
    return np.array([(CX + p[0]) * SS, (GROUND_Y - p[1]) * SS])


class Track:
    """Keyframed value. Each key eases ('s') or moves linearly ('l') from the previous one."""

    def __init__(self, v0):
        self.keys = [(-1e9, np.array(v0, float), 's')]

    @property
    def last(self):
        return self.keys[-1][1]

    def to(self, c0, c1, v, ease='s'):
        t_last, cur, _ = self.keys[-1]
        assert c0 >= t_last - 1e-9, (c0, t_last)
        if c0 > t_last:
            self.keys.append((c0, cur, 's'))
        self.keys.append((c1, np.array(v, float), ease))

    def get(self, c):
        k = self.keys
        if c >= k[-1][0]:
            return k[-1][1], 1.0, 0.0, 's'
        for i in range(len(k) - 1):
            c0, v0, _ = k[i]
            c1, v1, e = k[i + 1]
            if c0 <= c < c1:
                u = (c - c0) / (c1 - c0)
                f = u if e == 'l' else smooth(u)
                return v0 + (v1 - v0) * f, u, float(np.linalg.norm(v1 - v0)), e
        return k[0][1], 0.0, 0.0, 's'

    def val(self, c):
        v = self.get(c)[0]
        return float(v) if v.ndim == 0 else v


# ----------------------------------------------------------------- dancers
class Dancer:
    def __init__(self, female, height, X, theta):
        self.female = female
        self.h = height
        self.B = np.array([X, 0.0])
        self.th = theta
        h = height
        self.footL = Track(loc(self.B, theta, 0, 0.055, h))
        self.footR = Track(loc(self.B, theta, 0, -0.055, h))
        self.liftL = Track(0.0)
        self.liftR = Track(0.0)
        self.weight = Track(0.5)       # 0 = weight on left foot, 1 = on right foot
        self.theta = Track(theta)      # facing angle around the vertical axis
        self.lean = Track(0.0)         # forward (+) / backward (-) torso lean, radians
        self.drop = Track(0.0)         # extra pelvis drop, fraction of height
        self.pofs = Track(0.0)         # pelvis forward offset, fraction of height
        self.headtilt = Track(0.0)
        self.hands = {'L': [], 'R': []}
        if female:
            self.thigh, self.shin, self.ankle_h = 0.235, 0.225, 0.06
            self.upper, self.fore = 0.155, 0.15
            self.shoulder_w, self.hip_w = 0.088, 0.058
            self.head_r = 0.056
            self.leg_r = (0.034, 0.023, 0.012)
            self.arm_r = (0.018, 0.013, 0.009)
            self.levels = [  # (t along spine, half-width, half-depth, forward offset)
                (-0.06, 0.088, 0.066, -0.016),
                (0.38, 0.058, 0.044, 0.0),
                (0.70, 0.082, 0.070, 0.022),
                (0.95, 0.092, 0.045, 0.0),
                (1.04, 0.026, 0.024, 0.0)]
        else:
            self.thigh, self.shin, self.ankle_h = 0.245, 0.235, 0.04
            self.upper, self.fore = 0.165, 0.158
            self.shoulder_w, self.hip_w = 0.11, 0.055
            self.head_r = 0.060
            self.leg_r = (0.042, 0.032, 0.027)   # trousers
            self.arm_r = (0.023, 0.018, 0.012)
            self.levels = [
                (-0.10, 0.070, 0.050, -0.01),
                (0.0, 0.084, 0.060, -0.012),
                (0.38, 0.076, 0.054, 0.0),
                (0.75, 0.104, 0.066, 0.014),
                (0.96, 0.114, 0.050, 0.0),
                (1.04, 0.034, 0.030, 0.0)]

    @property
    def reach(self):
        return (self.upper + self.fore) * self.h * 0.985


# ------------------------------------------------------------ choreography
def step(d, foot, c0, x, z, dur=0.7, B=None, th=None):
    tr = d.footL if foot == 'L' else d.footR
    tr.to(c0, c0 + dur, loc(d.B if B is None else B, d.th if th is None else th, x, z, d.h))


def half_basic(d, c0, foot, sgn, s=0.15):
    """One half of the basic: step (1), replace weight (2), close (3), pause (4)."""
    z = 0.055 if foot == 'L' else -0.055
    wf = 0.0 if foot == 'L' else 1.0
    step(d, foot, c0, sgn * s, z)
    d.weight.to(c0 + 0.05, c0 + 0.85, wf)
    d.weight.to(c0 + 1.0, c0 + 1.8, 1 - wf)
    step(d, foot, c0 + 2, 0, z)
    d.weight.to(c0 + 2.0, c0 + 2.8, 0.5)


def basic(d, c0, first, sgn):
    half_basic(d, c0, first, sgn)
    half_basic(d, c0 + 4, 'R' if first == 'L' else 'L', -sgn)


def spin(d, c0, c1, dth):
    th0 = float(d.theta.last)
    d.theta.to(c0, c1, th0 + dth)
    d.weight.to(c0, c0 + 0.4, 0.5)
    n = max(4, int((c1 - c0) / 0.15))
    prev = c0
    for k in range(1, n + 1):
        t = c0 + (c1 - c0) * k / n
        th = th0 + dth * smooth(k / n)
        d.footL.to(prev, t, loc(d.B, th, 0, 0.03, d.h), ease='l')
        d.footR.to(prev, t, loc(d.B, th, 0, -0.03, d.h), ease='l')
        prev = t
    d.th = th0 + dth


def choreograph():
    m = Dancer(False, 420, -58, 0.0)
    w = Dancer(True, 395, 58, math.pi)

    # Bars 1-2: basic step (man forward on 1, woman back on 1)
    for c0 in (0, 8):
        basic(m, c0, 'L', +1)
        basic(w, c0, 'R', -1)

    # Bar 3: man keeps the basic, woman steps back then spins on 5-6-7
    basic(m, 16, 'L', +1)
    half_basic(w, 16, 'R', -1)
    spin(w, 20, 22.6, -2 * math.pi)
    step(w, 'L', 22.6, 0, 0.055, 0.6)
    step(w, 'R', 22.6, 0, -0.055, 0.6)

    # Bar 4: cross body lead - partners swap sides
    th = w.th
    step(w, 'R', 24, -0.12, -0.055)
    w.weight.to(24.05, 24.85, 1)
    step(w, 'L', 25, 0, 0.055, B=(10, 0))
    w.weight.to(25.0, 25.8, 0)
    step(w, 'R', 26, 0, -0.055, B=(-30, 0))
    w.weight.to(26.0, 26.8, 1)
    step(w, 'L', 28, 0, 0.04, 0.6, B=(-62, 0))
    w.weight.to(28.0, 28.7, 0)
    w.theta.to(28.3, 29.3, th + math.pi)
    w.th = th + math.pi
    w.B = np.array([-55.0, 0.0])
    step(w, 'R', 29, -0.06, -0.055)
    w.weight.to(29.0, 29.7, 1)
    step(w, 'L', 30, 0, 0.055)
    step(w, 'R', 30, 0, -0.055)
    w.weight.to(30.0, 30.8, 0.5)

    hm = m.h
    step(m, 'L', 24, 0.08, 0.055)
    m.weight.to(24.05, 24.85, 0)
    m.theta.to(25, 27, math.pi / 2)
    step(m, 'R', 25, -0.02, -0.055, B=(-50, 0.1 * hm), th=math.pi / 4)
    m.weight.to(25.0, 25.8, 1)
    step(m, 'L', 26, 0, 0.055, B=(-40, 0.1 * hm), th=math.pi / 2)
    m.weight.to(26.0, 26.8, 0.5)
    m.theta.to(28, 30, math.pi)
    step(m, 'R', 28, 0, -0.055, B=(0, 0.05 * hm), th=3 * math.pi / 4)
    m.weight.to(28.0, 28.8, 1)
    m.B, m.th = np.array([55.0, 0.0]), math.pi
    step(m, 'L', 29, 0, 0.055)
    m.weight.to(29.0, 29.8, 0)
    step(m, 'R', 30, 0, -0.055)
    m.weight.to(30.0, 30.8, 0.5)

    # Bar 5: half basic, then the dip and hold
    half_basic(m, 32, 'L', +1)
    half_basic(w, 32, 'R', -1)

    step(m, 'L', 35.5, 0.20, 0.055, 1.1)
    step(m, 'R', 35.5, -0.04, -0.055, 0.8)
    m.weight.to(35.5, 36.8, 0.25)
    m.lean.to(35.5, 37.0, 0.32)
    m.lean.to(37.0, 40.0, 0.36)
    m.drop.to(35.5, 37.0, 0.04)
    m.headtilt.to(35.5, 37.0, 0.25)

    step(w, 'R', 35.5, -0.08, -0.055, 0.8)
    w.weight.to(35.5, 36.5, 1)
    step(w, 'L', 35.8, 0.16, 0.055, 1.1)
    w.liftL.to(35.8, 37.0, 0.035)
    w.lean.to(35.6, 37.0, -0.70)
    w.lean.to(37.0, 40.0, -0.76)
    w.drop.to(35.6, 37.0, 0.10)
    w.pofs.to(35.6, 37.0, 0.08)
    w.headtilt.to(35.8, 37.2, -0.5)

    # Arms: each hand follows a list of (start count, target function)
    m.hands['L'] = [(0, J_closed), (11.5, J_low), (18.0, J_raise), (23.0, J_low), (34.0, J_dip)]
    w.hands['R'] = list(m.hands['L']) + [(35.6, free('w', 'R', -0.22, -0.04, 0.16))]
    m.hands['L'] = m.hands['L'] + [(35.6, free('m', 'L', -0.20, 0.13, 0.12))]
    m.hands['R'] = [(0, man_on_back), (11.5, free('m', 'R', 0.06, -0.12, 0.24)),
                    (34.0, man_on_back)]
    w.hands['L'] = [(0, woman_on_shoulder), (11.5, free('w', 'L', 0.02, 0.13, 0.24, wave=0.03)),
                    (19.5, free('w', 'L', 0.03, 0.03, 0.30)),
                    (23.5, free('w', 'L', 0.05, 0.12, 0.25, wave=0.03)),
                    (34.0, woman_on_shoulder)]
    return m, w


# ------------------------------------------------------- hand target funcs
def clamp_joint(pt, pairs):
    for _ in range(4):
        for s, r in pairs:
            d = pt - s
            n = np.linalg.norm(d)
            if n > r:
                pt = s + d * (r / n)
    return pt


def _joined(ctx, pt):
    m, w = ctx['m'], ctx['w']
    return clamp_joint(pt, [(m['S']['L'], m['reach']), (w['S']['R'], w['reach'])])


def J_closed(ctx):
    m, w = ctx['m'], ctx['w']
    pt = (m['S']['L'] + w['S']['R']) / 2 + UP * 0.05 * m['h'] + m['side'] * 0.10 * m['h']
    return _joined(ctx, pt)


def J_low(ctx):
    m, w = ctx['m'], ctx['w']
    pt = (m['S']['L'] + w['S']['R']) / 2
    pt[1] = (m['pelvis'][1] + w['pelvis'][1]) / 2 + 0.12 * m['h']
    return _joined(ctx, pt)


def J_raise(ctx):
    w = ctx['w']
    a = ctx['c'] * 2 * math.pi / 1.3
    pt = w['head'] + UP * 0.17 * w['h'] + np.array([math.cos(a), 0, math.sin(a)]) * 0.03 * w['h']
    return _joined(ctx, pt)


def J_dip(ctx):
    m, w = ctx['m'], ctx['w']
    pt = (m['S']['L'] + w['S']['R']) / 2 + UP * 0.12 * m['h'] + m['side'] * 0.12 * m['h']
    return _joined(ctx, pt)


def man_on_back(ctx):
    m, w = ctx['m'], ctx['w']
    pt = w['pelvis'] + w['u'] * 0.72 * w['T'] + w['side'] * 0.07 * w['h'] - w['fu'] * 0.04 * w['h']
    return clamp_joint(pt, [(m['S']['R'], m['reach'])])


def woman_on_shoulder(ctx):
    m, w = ctx['m'], ctx['w']
    pt = m['S']['R'] + UP * 0.012 * m['h'] - m['fu'] * 0.01 * m['h']
    return clamp_joint(pt, [(w['S']['L'], w['reach'])])


def free(who, arm, f, up, side, wave=0.0):
    def fn(ctx):
        P = ctx[who]
        out = P['side'] if arm == 'L' else -P['side']
        u = up + wave * math.sin(ctx['c'] * math.pi * 0.5)
        return P['S'][arm] + (P['F'] * f + UP * u + out * side) * P['h']
    return fn


def hand_target(plan, ctx, blend=0.8):
    idx = 0
    for i, (cs, _) in enumerate(plan):
        if ctx['c'] >= cs:
            idx = i
    cs, fn = plan[idx]
    cur = fn(ctx)
    if idx > 0 and ctx['c'] - cs < blend:
        prev = plan[idx - 1][1](ctx)
        cur = prev + (cur - prev) * smooth((ctx['c'] - cs) / blend)
    return cur


# --------------------------------------------------------------- skeleton
def ik(a, b, l1, l2, hint):
    d = b - a
    dist = np.linalg.norm(d)
    u = d / dist if dist > 1e-9 else DOWN
    dc = clamp(dist, abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999)
    end = a + u * dc
    x = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc)
    y = math.sqrt(max(l1 * l1 - x * x, 0.0))
    v = hint - u * np.dot(hint, u)
    v = norm(v) if np.linalg.norm(v) > 1e-6 else norm(np.cross(u, [0, 0, 1]))
    return a + u * x + v * y, end


def pelvis_xz(d, c):
    fl = d.footL.get(c)[0]
    fr = d.footR.get(c)[0]
    w = d.weight.val(c)
    th = d.theta.val(c)
    return fl + (fr - fl) * (0.15 + 0.7 * w) + fw2(th) * d.pofs.val(c) * d.h


def body(d, c):
    h = d.h
    th = d.theta.val(c)
    om = (d.theta.val(c + 0.04) - d.theta.val(c - 0.04)) / 0.08
    F = np.array([math.cos(th), 0, math.sin(th)])
    S = np.array([-math.sin(th), 0, math.cos(th)])

    ankles, lifts = {}, {}
    for k, tr, lt in (('L', d.footL, d.liftL), ('R', d.footR, d.liftR)):
        xz, u, dist, ease = tr.get(c)
        lift = lt.val(c) * h
        if ease == 's' and dist > 1 and u < 1:
            lift += math.sin(math.pi * u) * min(0.03 * h, 0.3 * dist)
        lifts[k] = lift
        ankles[k] = np.array([xz[0], d.ankle_h * h + lift, xz[1]])

    w = d.weight.val(c)
    pxz = pelvis_xz(d, c)
    py = (0.5 - d.drop.val(c)) * h - 0.012 * h * math.sin(math.pi * c) ** 2
    pelvis = np.array([pxz[0], py, pxz[1]])
    tilt = (w - 0.5) * 2 * 0.012 * h
    hips = {'L': pelvis + S * d.hip_w * h - UP * tilt, 'R': pelvis - S * d.hip_w * h + UP * tilt}

    # lower the pelvis if a planted foot would be out of reach
    leg = (d.thigh + d.shin) * h * 0.985
    lower = 0.0
    for k in 'LR':
        if lifts[k] < 0.01 * h:
            hp, an = hips[k], ankles[k]
            dh = math.hypot(hp[0] - an[0], hp[2] - an[2])
            maxv = math.sqrt(max(leg * leg - dh * dh, 0.0))
            lower = max(lower, (hp[1] - an[1]) - maxv)
    pelvis = pelvis - UP * lower
    hips = {k: v - UP * lower for k, v in hips.items()}

    knees = {}
    for k in 'LR':
        out = S if k == 'L' else -S
        knees[k], ankles[k] = ik(hips[k], ankles[k], d.thigh * h, d.shin * h, F + out * 0.15)

    lean = d.lean.val(c)
    u = UP * math.cos(lean) + F * math.sin(lean) - S * (w - 0.5) * 0.08
    u = norm(u)
    fu = norm(F * math.cos(lean) - UP * math.sin(lean))
    T = 0.30 * h
    neck = pelvis + u * T
    sh = neck - u * 0.02 * h
    shoulders = {'L': sh + S * d.shoulder_w * h, 'R': sh - S * d.shoulder_w * h}
    ht = d.headtilt.val(c)
    hd = u * math.cos(ht) + fu * math.sin(ht)
    fh = fu * math.cos(ht) - u * math.sin(ht)
    head = neck + hd * 0.105 * h

    vel = (pelvis_xz(d, c + 0.05) - pelvis_xz(d, c - 0.05)) / 0.1
    return dict(d=d, h=h, th=th, om=om, F=F, side=S, pelvis=pelvis, hips=hips, knees=knees,
                ankles=ankles, lifts=lifts, u=u, fu=fu, T=T, neck=neck, S=shoulders,
                head=head, hd=hd, fh=fh, vel=vel, reach=d.reach)


# ---------------------------------------------------------------- drawing
def capsule(dr, p1, r1, p2, r2):
    """Tapered limb between two screen points (radii in screen pixels)."""
    p1, p2 = np.asarray(p1), np.asarray(p2)
    dr.ellipse([p1[0] - r1, p1[1] - r1, p1[0] + r1, p1[1] + r1], fill=255)
    dr.ellipse([p2[0] - r2, p2[1] - r2, p2[0] + r2, p2[1] + r2], fill=255)
    dv = p2 - p1
    n = np.linalg.norm(dv)
    if n < 1e-6:
        return
    nv = np.array([-dv[1], dv[0]]) / n
    pts = [p1 + nv * r1, p2 + nv * r2, p2 - nv * r2, p1 - nv * r1]
    dr.polygon([tuple(p) for p in pts], fill=255)


def circle(dr, p, r):
    dr.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)


def ellipse_extent(a, b, A, Bv, n3):
    return math.sqrt((a * np.dot(A, n3)) ** 2 + (b * np.dot(Bv, n3)) ** 2)


def draw_torso(dr, P):
    d, h = P['d'], P['h']
    us = np.array([P['u'][0], -P['u'][1]])
    us = us / np.linalg.norm(us)
    ns = np.array([-us[1], us[0]])
    n3 = np.array([ns[0], -ns[1], 0.0])
    lv = d.levels
    dense = []
    for i in range(len(lv) - 1):
        for j in range(5):
            f = smooth(j / 5)
            dense.append(tuple(lv[i][k] + (lv[i + 1][k] - lv[i][k]) * f for k in range(4)))
    dense.append(lv[-1])
    left, right = [], []
    for t, a, b, fo in dense:
        cen = P['pelvis'] + P['u'] * t * P['T'] + P['fu'] * fo * h
        e = ellipse_extent(a * h, b * h, P['side'], P['fu'], n3) * SS
        cs = proj(cen)
        left.append(cs + ns * e)
        right.append(cs - ns * e)
    dr.polygon([tuple(p) for p in left + right[::-1]], fill=255)


def draw_skirt(dr, P, c):
    h = P['h']
    sf = clamp(abs(P['om']) / 3.5)
    top = P['pelvis'] + P['u'] * 0.30 * P['T']
    dip = clamp(-P['d'].lean.val(c) / 0.7)
    hdir = norm(DOWN + P['F'] * (0.05 + 0.55 * dip))
    hem = P['pelvis'] + hdir * (0.25 - 0.07 * sf - 0.03 * dip) * h
    hem = hem - np.array([P['vel'][0], 0, 0]) * 0.18
    rot = math.atan2(hdir[0], -hdir[1])  # screen tilt of the hem line
    r = (0.125 + 0.08 * sf) * h * SS
    tw = ellipse_extent(0.066 * h, 0.05 * h, P['side'], P['fu'], np.array([1.0, 0, 0])) * SS
    ts, hs = proj(top), proj(hem)
    amp = (0.007 + 0.014 * sf) * h * SS
    pts = [(ts[0] - tw, ts[1])]
    N = 28
    for i in range(N + 1):
        ph = math.pi - math.pi * i / N
        x = hs[0] + r * math.cos(ph)
        y = hs[1] + 0.012 * h * SS * math.sin(ph) + amp * math.sin(7 * ph + 2.5 * P['th'] + 0.8 * c)
        if i in (0, N):
            y -= 0.02 * h * SS * sf
        dx, dy = x - hs[0], y - hs[1]
        pts.append((hs[0] + dx * math.cos(rot) - dy * math.sin(rot),
                    hs[1] + dx * math.sin(rot) + dy * math.cos(rot)))
    pts.append((ts[0] + tw, ts[1]))
    dr.polygon(pts, fill=255)


def draw_feet(dr, P):
    d, h = P['d'], P['h']
    for k in 'LR':
        A = P['ankles'][k]
        lift = P['lifts'][k]
        if d.female:
            pointed = lift > 0.02 * h
            toe = A + P['F'] * 0.075 * h
            toe[1] = A[1] - 0.012 * h if pointed else lift + 0.01 * h
            capsule(dr, proj(A), 0.015 * h * SS, proj(toe), 0.008 * h * SS)
            if not pointed:
                heel = A - P['F'] * 0.018 * h
                heel_g = heel.copy()
                heel_g[1] = lift
                capsule(dr, proj(heel), 0.009 * h * SS, proj(heel_g), 0.004 * h * SS)
        else:
            toe = A + P['F'] * 0.085 * h
            toe[1] = lift + 0.013 * h
            heel = A - P['F'] * 0.022 * h
            heel[1] = lift + 0.016 * h
            capsule(dr, proj(heel), 0.017 * h * SS, proj(toe), 0.013 * h * SS)
            capsule(dr, proj(A), 0.026 * h * SS, proj(toe), 0.013 * h * SS)


def draw_head(dr, P):
    d, h = P['d'], P['h']
    hc = P['head']
    capsule(dr, proj(P['neck'] - P['u'] * 0.03 * h), 0.03 * h * SS, proj(hc), 0.026 * h * SS)
    circle(dr, proj(hc), d.head_r * h * SS)
    circle(dr, proj(hc + P['fh'] * 0.056 * h - P['hd'] * 0.006 * h), 0.013 * h * SS)   # nose
    circle(dr, proj(hc + P['fh'] * 0.026 * h - P['hd'] * 0.03 * h), 0.03 * h * SS)    # jaw
    hs = np.array([P['hd'][0], -P['hd'][1]])
    hs = hs / np.linalg.norm(hs)
    perp = np.array([-hs[1], hs[0]])
    if d.female:
        sf = clamp(abs(P['om']) / 3.5)
        bun = hc + P['hd'] * 0.035 * h - P['fh'] * 0.045 * h
        circle(dr, proj(bun), 0.03 * h * SS)
        spin_dir = -1.0 if P['om'] > 0 else 1.0
        dir0 = norm(-P['fh'] * (0.8 + 0.4 * sf) + DOWN * (0.6 - 0.3 * sf) + P['side'] * spin_dir * 0.35 * sf)
        p = bun - P['fh'] * 0.012 * h
        radii = [0.020, 0.016, 0.010, 0.004]
        for k in range(3):
            dk = norm(dir0 + DOWN * 0.45 * (k + 1) * (1 - 0.5 * sf))
            q = p + dk * 0.036 * h
            capsule(dr, proj(p), radii[k] * h * SS, proj(q), radii[k + 1] * h * SS)
            p = q
    else:
        bc = proj(hc + P['hd'] * 0.042 * h)
        L = 0.105 * h * SS
        capsule(dr, bc - perp * L, 0.008 * h * SS, bc + perp * L, 0.008 * h * SS)
        top = bc + hs * 0.078 * h * SS
        dent = bc + hs * 0.066 * h * SS
        crown = [bc - perp * 0.06 * h * SS, top - perp * 0.05 * h * SS, dent,
                 top + perp * 0.05 * h * SS, bc + perp * 0.06 * h * SS]
        dr.polygon([tuple(p) for p in crown], fill=255)


def draw_dancer(dr, P, hands, c):
    d, h = P['d'], P['h']
    for k in 'LR':
        r0, r1, r2 = (x * h * SS for x in d.leg_r)
        capsule(dr, proj(P['hips'][k]), r0, proj(P['knees'][k]), r1)
        capsule(dr, proj(P['knees'][k]), r1, proj(P['ankles'][k]), r2)
    draw_feet(dr, P)
    draw_torso(dr, P)
    if d.female:
        draw_skirt(dr, P, c)
    for k in 'LR':
        out = P['side'] if k == 'L' else -P['side']
        hint = DOWN + out * 0.7 - P['F'] * 0.2
        elbow, hand = ik(P['S'][k], hands[k], d.upper * h, d.fore * h, hint)
        r0, r1, r2 = (x * h * SS for x in d.arm_r)
        circle(dr, proj(P['S'][k]), r0 * 1.25)
        capsule(dr, proj(P['S'][k]), r0, proj(elbow), r1)
        capsule(dr, proj(elbow), r1, proj(hand), r2)
        circle(dr, proj(hand), 0.017 * h * SS)
    draw_head(dr, P)


# ------------------------------------------------------------- background
def lerp_stops(stops, y):
    ys = np.array([s[0] for s in stops], float)
    cols = np.array([s[1] for s in stops], float)
    return np.stack([np.interp(y, ys, cols[:, i]) for i in range(3)], axis=-1)


def build_background():
    yy, xx = np.mgrid[0:H, 0:W].astype(float)
    sky = lerp_stops([(0, (26, 10, 50)), (240, (84, 26, 90)), (470, (190, 56, 96)),
                      (640, (248, 116, 70)), (760, (255, 176, 92))], yy)
    sun_c = np.array([CX, 742.0])
    dist = np.hypot(xx - sun_c[0], yy - sun_c[1])
    sky += np.exp(-(dist / 330) ** 2)[..., None] * np.array([255, 140, 60]) * 0.45
    sky += np.exp(-(dist / 700) ** 2)[..., None] * np.array([120, 40, 30]) * 0.35
    sun_col = lerp_stops([(530, (255, 240, 180)), (760, (255, 150, 70))], yy)
    disk = np.clip((205 - dist) / 2.5, 0, 1)[..., None]
    img = sky * (1 - disk) + sun_col * disk

    sea_rows = slice(HORIZON_Y, GROUND_Y)
    sea = lerp_stops([(HORIZON_Y, (236, 128, 88)), (GROUND_Y, (112, 42, 84))], yy[sea_rows])
    img[sea_rows] = sea
    img[HORIZON_Y:HORIZON_Y + 2] *= 0.86
    ground = lerp_stops([(GROUND_Y, (20, 9, 24)), (H, (8, 3, 10))], yy[GROUND_Y:])
    img[GROUND_Y:] = ground

    vig = 1 - 0.38 * (((xx - CX) / CX) ** 2 * 0.6 + ((yy - H / 2) / (H / 2)) ** 2 * 0.5)
    return np.clip(img, 0, 255), np.clip(vig, 0, 1)[..., None]


rng = np.random.default_rng(7)
SEA_PH1 = rng.uniform(0, 2 * np.pi, GROUND_Y - HORIZON_Y)[:, None]
SEA_PH2 = rng.uniform(0, 2 * np.pi, GROUND_Y - HORIZON_Y)[:, None]
SEA_X = np.arange(W, dtype=float)[None, :]
SEA_Y = np.arange(HORIZON_Y, GROUND_Y, dtype=float)[:, None]


def sea_shimmer(t):
    width = 120 + (SEA_Y - HORIZON_Y) * 1.6
    env = np.exp(-((SEA_X - CX) / width) ** 2)
    s1 = 0.5 + 0.5 * np.sin(0.055 * SEA_X + SEA_PH1 + 1.8 * t)
    s2 = np.sin(0.012 * SEA_X - 0.9 * t + SEA_PH2)
    v = np.clip(s1 * s2 - 0.3, 0, 1) * 2.2 * env
    return v[..., None] * np.array([255, 214, 150]) * 0.75


def palm(dr, base, ctrl, top, t, scale=1.0, seed=0):
    base, ctrl, top = (np.array(p, float) * SS for p in (base, ctrl, top))
    for i in range(40):
        u = i / 39
        p = (1 - u) ** 2 * base + 2 * (1 - u) * u * ctrl + u * u * top
        circle(dr, p, (22 - 10 * u) * scale * SS)
    angles = [-172, -145, -118, -88, -55, -25, 5, 30, 150]
    for i, a in enumerate(angles):
        a = math.radians(a + 3.5 * math.sin(1.1 * t + i * 1.7 + seed))
        L = (230 - 25 * (i % 3)) * scale * SS
        droop = (150 if abs(math.cos(a)) > 0.5 else 70) * scale * SS
        dvec = np.array([math.cos(a), math.sin(a)])
        prev = top
        for j in range(1, 19):
            u = j / 18
            p = top + dvec * L * u + np.array([0, droop * u * u])
            capsule(dr, prev, (6 - 4 * u) * scale * SS, p, (6 - 4 * u) * scale * SS)
            tang = norm(p - prev)
            nrm = np.array([-tang[1], tang[0]])
            if nrm[1] < 0:
                nrm = -nrm
            ll = 62 * math.sin(math.pi * (0.15 + 0.8 * u)) * scale * SS
            for sgn, k in ((1, 1.0), (-1, 0.45)):
                tip = p + (nrm * sgn * 0.8 + tang * 0.6) * ll * k
                capsule(dr, p, 4.5 * scale * SS, tip, 1.0 * SS)
            prev = p
    for k in range(3):
        circle(dr, top + np.array([(k - 1) * 13, 14]) * scale * SS, 12 * scale * SS)


LIGHT_A = np.array([345.0, 318.0])
LIGHT_B = np.array([1598.0, 302.0])


def wire_y(x):
    u = (x - LIGHT_A[0]) / (LIGHT_B[0] - LIGHT_A[0])
    return LIGHT_A[1] + (LIGHT_B[1] - LIGHT_A[1]) * u + 4 * 70 * u * (1 - u)


BULBS = [(x, wire_y(x) + 11) for x in np.linspace(LIGHT_A[0] + 40, LIGHT_B[0] - 40, 24)]
BULB_COLS = [np.array(c, float) for c in ((255, 214, 140), (255, 140, 0), (255, 214, 140), (0, 200, 255))]
_g = np.arange(-40, 41, dtype=float)
GLOW = np.exp(-(_g[None, :] ** 2 + _g[:, None] ** 2) / (2 * 11.0 ** 2))
CORE = np.clip(4.5 - np.hypot(_g[None, :], _g[:, None]), 0, 1)


def draw_scenery(dr, t):
    palm(dr, (195, 980), (100, 640), (330, 300), t, 1.0, 0)
    palm(dr, (1755, 980), (1870, 620), (1612, 286), t, 1.0, 2)
    palm(dr, (1890, 990), (1915, 720), (1835, 500), t, 0.62, 4)
    xs = np.linspace(LIGHT_A[0], LIGHT_B[0], 120)
    pts = [(x * SS, wire_y(x) * SS) for x in xs]
    dr.line(pts, fill=255, width=3 * SS)
    for x, y in BULBS:
        dr.line([(x * SS, (y - 11) * SS), (x * SS, (y - 4) * SS)], fill=255, width=2 * SS)
    # sailboat drifting on the horizon
    bx = 1330 + 4 * t
    hull = [(bx - 22, HORIZON_Y - 4), (bx + 22, HORIZON_Y - 4), (bx + 15, HORIZON_Y + 3), (bx - 15, HORIZON_Y + 3)]
    dr.polygon([(x * SS, y * SS) for x, y in hull], fill=255)
    dr.polygon([((bx - 2) * SS, (HORIZON_Y - 6) * SS), ((bx - 2) * SS, (HORIZON_Y - 52) * SS),
                ((bx + 18) * SS, (HORIZON_Y - 8) * SS)], fill=255)
    dr.polygon([((bx - 5) * SS, (HORIZON_Y - 8) * SS), ((bx - 5) * SS, (HORIZON_Y - 40) * SS),
                ((bx - 20) * SS, (HORIZON_Y - 8) * SS)], fill=255)
    # a few birds
    for k in range(3):
        cx = 1300 - 18 * t + k * 58
        cy = 150 + k * 26 + 6 * math.sin(0.8 * t + k)
        f = math.sin(2 * math.pi * 2.2 * t + k * 1.3)
        s = 1.0 - 0.15 * k
        for sgn in (-1, 1):
            pts = [(cx, cy), (cx + sgn * 11 * s, cy - (4 + 7 * f) * s), (cx + sgn * 22 * s, cy - (1 + 9 * f) * s)]
            dr.line([(x * SS, y * SS) for x, y in pts], fill=255, width=3 * SS, joint='curve')


def add_bulbs(img, t):
    for i, (x, y) in enumerate(BULBS):
        b = 0.75 + 0.25 * math.sin(3.1 * t + i * 1.9)
        col = BULB_COLS[i % len(BULB_COLS)]
        xi, yi = int(round(x)), int(round(y))
        sl = img[yi - 40:yi + 41, xi - 40:xi + 41]
        sl += (GLOW * 0.55 * b)[..., None] * col
        sl += (CORE * b)[..., None] * (col * 0.4 + 153)


# -------------------------------------------------------------- rendering
def render_frame(t, m, w, bg, vig):
    c = t / BEAT
    Pm, Pw = body(m, c), body(w, c)
    ctx = {'m': Pm, 'w': Pw, 'c': c}
    hm = {k: hand_target(m.hands[k], ctx) for k in 'LR'}
    hw = {k: hand_target(w.hands[k], ctx) for k in 'LR'}

    mask = Image.new('L', (W * SS, H * SS), 0)
    dr = ImageDraw.Draw(mask)
    draw_scenery(dr, t)
    draw_dancer(dr, Pm, hm, c)
    draw_dancer(dr, Pw, hw, c)
    a = np.asarray(mask.reduce(SS), dtype=float)[..., None] / 255.0

    img = bg.copy()
    img[HORIZON_Y:GROUND_Y] += sea_shimmer(t)
    img = img * (1 - a) + INK * a
    add_bulbs(img, t)
    img *= vig
    fade = smooth(t / 0.6) * smooth((DURATION - t) / 0.7)
    img *= fade
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = args[0] if args else 'salsa_dancers.mp4'
    m, w = choreograph()
    bg, vig = build_background()

    if '--preview' in sys.argv:
        for t in (1.0, 4.4, 7.9, 10.2, 14.2):
            Image.fromarray(render_frame(t, m, w, bg, vig)).save(f'preview_{t:04.1f}.png')
        return

    n = int(round(DURATION * FPS))
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
           '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow',
           '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in range(n):
        proc.stdin.write(render_frame(f / FPS, m, w, bg, vig).tobytes())
        if f % 30 == 0:
            print(f'frame {f}/{n}', flush=True)
    proc.stdin.close()
    proc.wait()
    print('wrote', out)


if __name__ == '__main__':
    main()
