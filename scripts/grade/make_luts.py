"""Bake the grade app's ACES base looks: each camera profile's code values → ACES2065-1 → ACES 2.0 SDR Rec.709.

    uv run --with opencolorio --with numpy scripts/grade/make_luts.py ~/Movies/Pocket4P/luts

Writes dlog2-, dlog- and hlg-to-rec709-aces2.cube (65 points). Sources: DJI's D-Log/D-Gamut white paper (through
OpenColorIO's built-in "D-Log D-Gamut"), DJI's D-Log2 DCTL constants and D-Gamut2 primaries as quoted in
aces-aswf/aces-input-and-colorspaces#36, BT.2100 HLG, and OpenColorIO's ACES studio config for the output.
Exposure, white balance and the rest are the app's own (scripts/grade/color.mjs), applied before these.
"""
import sys
from pathlib import Path

import numpy as np
import PyOpenColorIO as ocio

CFG = ocio.Config.CreateFromFile("ocio://studio-config-latest")
DISPLAY, VIEW = "Rec.1886 Rec.709 - Display", "ACES 2.0 - SDR 100 nits (Rec.709)"
D65, ACES_W = (0.3127, 0.3290), (0.32168, 0.33767)
AP0 = [(0.7347, 0.2653), (0.0, 1.0), (0.0001, -0.0770)]
DGAMUT2 = [(0.7347, 0.2653), (0.16, 0.84), (0.09, -0.08)]
REC2020 = [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)]
CAT02 = np.array([[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.0030, 0.0136, 0.9834]])


def xyz(x, y):
    return np.array([x / y, 1.0, (1 - x - y) / y])


def rgb_to_xyz(prims, white):
    P = np.stack([xyz(*p) for p in prims], axis=1)
    return P * np.linalg.solve(P, xyz(*white))


def to_ap0(prims):
    cat = np.linalg.inv(CAT02) @ np.diag((CAT02 @ xyz(*ACES_W)) / (CAT02 @ xyz(*D65))) @ CAT02
    return np.linalg.inv(rgb_to_xyz(AP0, ACES_W)) @ cat @ rgb_to_xyz(prims, D65)


def dlog2_to_lin(x):
    H, a = 475.0, 16.285770761945304
    k1, b1, k2, b2, l2 = 0.059439938321493, 0.304985337243402, 2.960935245492250, 0.148314799066323, 0.028961695254132
    return np.where(x >= b1, H / (2.0**a - 1.0) * (2.0 ** (a * x) - 1.0),
                    np.where(x >= b2, 2.0 ** ((x - b1) / k1 + np.log2(0.18)), (x - b2) / k2 + l2))


def hlg_to_scene(x):
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    e = np.where(x <= 0.5, x * x / 3.0, (np.exp((x - c) / a) + b) / 12.0)
    return e * (0.18 / (0.38 * 0.38 / 3.0))


def apply(proc, rgb):
    a = np.ascontiguousarray(rgb, dtype=np.float32).copy()
    proc.applyRGB(a)
    return a


def aces_linear(profile, code):
    if profile == "dlog":
        t = ocio.ColorSpaceTransform(src="D-Log D-Gamut", dst="ACES2065-1")
        return apply(CFG.getProcessor(t).getDefaultCPUProcessor(), code)
    if profile == "dlog2":
        return dlog2_to_lin(code) @ to_ap0(DGAMUT2).T
    if profile == "hlg":
        return hlg_to_scene(code) @ to_ap0(REC2020).T
    raise ValueError(profile)


def main(out_dir, n=65):
    out = Path(out_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # .cube: red varies fastest
    code = np.stack([r, gg, b], axis=-1).reshape(-1, 3)
    display = CFG.getProcessor(ocio.DisplayViewTransform(src="ACES2065-1", display=DISPLAY, view=VIEW)).getDefaultCPUProcessor()
    for profile in ("dlog2", "dlog", "hlg"):
        rgb = np.clip(apply(display, aces_linear(profile, code)), 0, 1)
        path = out / f"{profile}-to-rec709-aces2.cube"
        with open(path, "w") as f:
            f.write(f'TITLE "{profile} to Rec.709, ACES 2.0 SDR"\nLUT_3D_SIZE {n}\n')
            f.writelines(f"{p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n" for p in rgb)
        print(path)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "~/Movies/Pocket4P/luts")
