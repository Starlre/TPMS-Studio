"""GPU implicit preview helpers.

Provides fallback decisions, uniform building and GLSL sources for
ray-marched TPMS preview.  All user-controlled values are passed via
uniforms – no GLSL code is generated from raw user input.
"""

from __future__ import annotations

from dataclasses import dataclass

from tpms_core import CUSTOM_SURFACE, TPMSParameters, TPMS_FORMULAS

SUPPORTED_SURFACES = {"Gyroid", "Diamond", "Primitive", "I-WP", "Neovius"}
SURFACE_TO_INDEX = {
    "Gyroid": 0,
    "Diamond": 1,
    "Primitive": 2,
    "I-WP": 3,
    "Neovius": 4,
}


@dataclass(frozen=True)
class GpuPreviewState:
    supported: bool
    active: bool
    fallback_reason: str = ""


def can_use_gpu_preview(params: TPMSParameters) -> tuple[bool, str]:
    """Return (can_use, reason).  Custom formulas always fall back."""
    if params.surface == CUSTOM_SURFACE:
        return False, "custom_formula"
    if params.surface not in SUPPORTED_SURFACES:
        return False, f"unsupported_surface:{params.surface}"
    # All other parameters are representable via uniforms.
    # Gradient and porosity are handled; porosity solved values are passed
    # as thickness/isoLevel after CPU solves.
    return True, ""


def surface_index(surface: str) -> int:
    return SURFACE_TO_INDEX.get(surface, -1)


def is_custom_formula_safe_to_fallback(expression: str) -> bool:
    """Always fallback for custom – we do not attempt GLSL translation."""
    # For now every custom formula falls back to mesh preview.
    return False


# ---------------------------------------------------------------------------
# GLSL sources – 330 core, shared by OpenGLMeshView
# ---------------------------------------------------------------------------

IMPLICIT_VERTEX_SOURCE = """#version 330 core
layout(location = 0) in vec2 a_pos;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
"""

IMPLICIT_FRAGMENT_SOURCE = """#version 330 core
out vec4 frag_color;
uniform mat4 u_invViewProj;
uniform vec2 u_viewport;
uniform vec3 u_size;
uniform vec3 u_cells;
uniform int u_surface;
uniform int u_mode;
uniform float u_thickness;
uniform float u_isoLevel;
uniform int u_gradEnabled;
uniform int u_gradAxis;
uniform float u_gradStart;
uniform float u_gradEnd;
uniform float u_lightBg;
uniform vec3 u_pan;
uniform int u_maxSteps;
uniform float u_minStep;
uniform float u_maxStep;
uniform float u_maxDist;
uniform float u_eps;
const float PI = 3.14159265358979323846;
float evalField(vec3 local) {
    float px = 2.0 * PI * u_cells.x * (local.x / u_size.x + 0.5);
    float py = 2.0 * PI * u_cells.y * (local.y / u_size.y + 0.5);
    float pz = 2.0 * PI * u_cells.z * (local.z / u_size.z + 0.5);
    float cx = cos(px); float cy = cos(py); float cz = cos(pz);
    float sx = sin(px); float sy = sin(py); float sz = sin(pz);
    if (u_surface == 0) { return sx*cy + sy*cz + sz*cx; } else if (u_surface == 1) { return sx*sy*sz + sx*cy*cz + cx*sy*cz + cx*cy*sz; } else if (u_surface == 2) { return cx + cy + cz; } else if (u_surface == 3) { return 2.0*(cx*cy + cy*cz + cz*cx) - (cos(2.0*px) + cos(2.0*py) + cos(2.0*pz)); } else if (u_surface == 4) { return 3.0*(cx + cy + cz) + 4.0*cx*cy*cz; } return 0.0;
}
vec3 evalGrad(vec3 local) {
    float px = 2.0 * PI * u_cells.x * (local.x / u_size.x + 0.5);
    float py = 2.0 * PI * u_cells.y * (local.y / u_size.y + 0.5);
    float pz = 2.0 * PI * u_cells.z * (local.z / u_size.z + 0.5);
    float cx = cos(px); float cy = cos(py); float cz = cos(pz);
    float sx = sin(px); float sy = sin(py); float sz = sin(pz);
    float kx = 2.0 * PI * u_cells.x / u_size.x;
    float ky = 2.0 * PI * u_cells.y / u_size.y;
    float kz = 2.0 * PI * u_cells.z / u_size.z;
    float dFdx = 0.0; float dFdy = 0.0; float dFdz = 0.0;
    if (u_surface == 0) { float dFdu = cx*cy - sz*sx; float dFdv = -sx*sy + cy*cz; float dFdw = -sy*sz + cz*cx; dFdx = dFdu * kx; dFdy = dFdv * ky; dFdz = dFdw * kz; } else if (u_surface == 1) { float dFdu = cx*sy*sz + cx*cy*cz - sx*sy*cz - sx*cy*sz; float dFdv = sx*cy*sz - sx*sy*cz + cx*cy*cz - cx*sy*sz; float dFdw = sx*sy*cz - sx*cy*sz - cx*sy*sz + cx*cy*cz; dFdx = dFdu * kx; dFdy = dFdv * ky; dFdz = dFdw * kz; } else if (u_surface == 2) { dFdx = -sx * kx; dFdy = -sy * ky; dFdz = -sz * kz; } else if (u_surface == 3) { float dFdu = -2.0*sx*(cy+cz) + 2.0*sin(2.0*px); float dFdv = -2.0*sy*(cx+cz) + 2.0*sin(2.0*py); float dFdw = -2.0*sz*(cx+cy) + 2.0*sin(2.0*pz); dFdx = dFdu * kx; dFdy = dFdv * ky; dFdz = dFdw * kz; } else if (u_surface == 4) { float dFdu = -sx*(3.0 + 4.0*cy*cz); float dFdv = -sy*(3.0 + 4.0*cx*cz); float dFdw = -sz*(3.0 + 4.0*cx*cy); dFdx = dFdu * kx; dFdy = dFdv * ky; dFdz = dFdw * kz; } return vec3(dFdx, dFdy, dFdz);
}
float getThickness(vec3 local) { if (u_gradEnabled == 1) { float uCoord; if (u_gradAxis == 0) uCoord = (local.x + u_size.x*0.5) / u_size.x; else if (u_gradAxis == 1) uCoord = (local.y + u_size.y*0.5) / u_size.y; else uCoord = (local.z + u_size.z*0.5) / u_size.z; uCoord = clamp(uCoord, 0.0, 1.0); return mix(u_gradStart, u_gradEnd, uCoord); } else { return u_thickness; } }
float evalBox(vec3 local) { float bx = abs(local.x) - u_size.x*0.5; float by = abs(local.y) - u_size.y*0.5; float bz = abs(local.z) - u_size.z*0.5; return max(bx, max(by, bz)); }
float evalMaterial(vec3 local) { float f = evalField(local); vec3 g = evalGrad(local); float gLen = max(length(g), 1e-6); float thick = getThickness(local); if (u_mode == 0) { return abs(f) / gLen - thick*0.5; } else { return (u_isoLevel - f) / gLen; } }
float evalMap(vec3 pWorld) { vec3 local = pWorld - u_pan; float box = evalBox(local); float mat = evalMaterial(local); return max(mat, box); }
vec3 getBoxNormal(vec3 local) { float bx = abs(local.x) - u_size.x*0.5; float by = abs(local.y) - u_size.y*0.5; float bz = abs(local.z) - u_size.z*0.5; if (bx >= by && bx >= bz) return vec3(sign(local.x), 0.0, 0.0); else if (by >= bx && by >= bz) return vec3(0.0, sign(local.y), 0.0); else return vec3(0.0, 0.0, sign(local.z)); }
vec3 getAnalyticNormal(vec3 local) { vec3 g = evalGrad(local); float len = length(g); if (len < 1e-6) return vec3(0.0, 0.0, 1.0); vec3 n = normalize(g); if (u_mode == 0) { float f = evalField(local); n *= sign(f); if (f == 0.0) n = normalize(g); } else { n = -n; } return n; }
vec3 getNormal(vec3 pWorld) { vec3 local = pWorld - u_pan; float box = evalBox(local); float mat = evalMaterial(local); if (box > mat - 1e-5) { return getBoxNormal(local); } else { return getAnalyticNormal(local); } }
bool rayBoxIntersect(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float tNear, out float tFar) { vec3 invDir = 1.0 / rd; vec3 t0 = (bmin - ro) * invDir; vec3 t1 = (bmax - ro) * invDir; vec3 tmin = min(t0, t1); vec3 tmax = max(t0, t1); tNear = max(max(tmin.x, tmin.y), tmin.z); tFar = min(min(tmax.x, tmax.y), tmax.z); return tFar >= max(tNear, 0.0); }
void main() {
    vec2 vp = u_viewport; vp = max(vp, vec2(1.0, 1.0)); vec2 ndc = (gl_FragCoord.xy / vp) * 2.0 - 1.0;
    vec4 nearPos = u_invViewProj * vec4(ndc, -1.0, 1.0); vec4 farPos = u_invViewProj * vec4(ndc, 1.0, 1.0); nearPos /= nearPos.w; farPos /= farPos.w;
    vec3 ro = nearPos.xyz; vec3 rd = normalize(farPos.xyz - nearPos.xyz);
    if (dot(rd, rd) < 1e-12) { vec3 bg = mix(vec3(0.035,0.055,0.07), vec3(0.975,0.982,0.978), u_lightBg); frag_color = vec4(bg, 1.0); return; }
    vec3 bmin = vec3(-u_size*0.5) + u_pan; vec3 bmax = vec3( u_size*0.5) + u_pan;
    float tNear, tFar; bool hitBox = rayBoxIntersect(ro, rd, bmin, bmax, tNear, tFar);
    if (!hitBox || tFar < 0.0) { vec3 bg = mix(vec3(0.035,0.055,0.07), vec3(0.975,0.982,0.978), u_lightBg); frag_color = vec4(bg, 1.0); return; }
    tNear = max(tNear, 0.0); tFar = min(tFar, u_maxDist); if (tNear > tFar) { vec3 bg = mix(vec3(0.035,0.055,0.07), vec3(0.975,0.982,0.978), u_lightBg); frag_color = vec4(bg, 1.0); return; }
    float probeEps = max(u_minStep, u_eps) * 1.5;
    float dAtNear = evalMap(ro + rd * tNear);
    vec3 hitPos = vec3(0.0); vec3 hitNormal = vec3(0.0, 0.0, 1.0); bool hasHit = false;
    if (abs(dAtNear) < probeEps * 0.85) {
        float tProbe = tNear + probeEps;
        if (tProbe <= tFar) {
            float dProbe = evalMap(ro + rd * tProbe);
            if (dProbe < -probeEps * 0.2) { hasHit = true; hitPos = ro + rd * tNear; hitNormal = getBoxNormal(hitPos - u_pan); }
        }
    }
    if (!hasHit) {
        float prevD = dAtNear; float prevT = tNear; float t = tNear + probeEps;
        for (int i = 0; i < 128; ++i) {
            if (i >= u_maxSteps) break; if (t > tFar) break;
            float curD = evalMap(ro + rd * t);
            if (prevD > 0.0 && curD <= 0.0) {
                float lo = prevT; float hi = t; float dLo = prevD; float dHi = curD;
                for (int j = 0; j < 6; ++j) { float mid = (lo + hi) * 0.5; float dMid = evalMap(ro + rd * mid); if (dMid <= 0.0) { hi = mid; dHi = dMid; } else { lo = mid; dLo = dMid; } }
                hitPos = ro + rd * hi; hitNormal = getNormal(hitPos); hasHit = true; break;
            }
            float stepDist = clamp(abs(curD) * 0.65, u_minStep, u_maxStep);
            prevD = curD; prevT = t; t += stepDist; if (t > u_maxDist) break;
        }
    }
    if (hasHit) {
        vec3 n = hitNormal; vec3 viewDir = normalize(ro - hitPos);
        vec3 key = normalize(vec3(-0.45, -0.55, 0.75)); vec3 fill = normalize(vec3(0.70, 0.15, 0.30));
        float light = 0.12 + 0.72 * max(dot(n, key), 0.0) + 0.18 * max(dot(n, fill), 0.0);
        float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.4);
        vec3 dark_base = vec3(0.09, 0.46, 0.62); vec3 light_base = vec3(0.018, 0.22, 0.34);
        vec3 base = mix(dark_base, light_base, u_lightBg);
        float ambient = 0.30; float diffuse_scale = mix(0.92, 0.76, u_lightBg); float rim_scale = mix(0.16, 0.07, u_lightBg);
        vec3 color = base * (ambient + light * diffuse_scale) + vec3(0.24, 0.72, 0.82) * rim * rim_scale;
        color = pow(clamp(color, 0.0, 1.0), vec3(0.88)); frag_color = vec4(color, 1.0); return;
    }
    vec3 bg = mix(vec3(0.035,0.055,0.07), vec3(0.975,0.982,0.978), u_lightBg); frag_color = vec4(bg, 1.0);
}

"""


def build_uniform_dict(params: TPMSParameters, viewport: tuple[int, int] | None = None) -> dict:
    """Build a dict of uniforms for testing (not GL binding)."""
    can, _ = can_use_gpu_preview(params)
    return {
        "surface": params.surface,
        "surface_index": surface_index(params.surface),
        "mode": params.mode,
        "size": (params.size_x, params.size_y, params.size_z),
        "cells": (params.cells_x, params.cells_y, params.cells_z),
        "thickness": params.thickness,
        "iso_level": params.iso_level,
        "gradient_enabled": params.gradient_enabled,
        "gradient_axis": params.gradient_axis,
        "gradient_start": params.gradient_thickness_start,
        "gradient_end": params.gradient_thickness_end,
        "can_use_gpu": can,
    }
