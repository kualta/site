"""Bake the grade app's generated base looks: each camera profile's code values → ACES2065-1 → a display rendering.

    uv run --with opencolorio --with numpy scripts/grade/make_luts.py "~/Library/Application Support/Grade/luts"

For D-Log2, D-Log and HLG it writes (65 points, Rec.709 BT.1886 out):

    <profile>-to-rec709-aces2.cube   ACES 2.0 SDR 100 nits (OpenColorIO's studio config)
    <profile>-to-rec709-aces1.cube   ACES 1.0 SDR Video, the older, punchier ACES rendering (studio config v2.1.0)
    agx/<profile>-<look>.cube        AgX Base and its looks, from Blender's OpenColorIO config (--blender, found in
                                     /Applications/Blender.app when present)
    <pack>/<profile>-<look>.cube     another camera maker's LUT, fed that camera's log: the footage is converted from
                                     ACES2065-1 into the LUT's own input space (F-Log2, LogC4, LogC3, S-Log3,
                                     OpenDRT's T-LogE), then run through the LUT unmodified. Sources go in
                                     <out>/vendor/<pack>/ (see VENDOR and the app's README); missing ones are skipped.

Sources: DJI's D-Log/D-Gamut white paper (through OpenColorIO's built-in "D-Log D-Gamut"), DJI's D-Log2 DCTL
constants and D-Gamut2 primaries as quoted in aces-aswf/aces-input-and-colorspaces#36, BT.2100 HLG, Fujifilm's
F-Log2 data sheet (constants as in colour-science 0.4.7). Exposure, white balance and the rest are the app's own
(scripts/grade/color.mjs), applied before these.
"""
import argparse
import glob
from pathlib import Path

import numpy as np
import PyOpenColorIO as ocio

CFG = ocio.Config.CreateFromFile("ocio://studio-config-latest")
CFG_ACES1 = ocio.Config.CreateFromFile("ocio://studio-config-v2.1.0_aces-v1.3_ocio-v2.3")
DISPLAY = "Rec.1886 Rec.709 - Display"
D65, ACES_W = (0.3127, 0.3290), (0.32168, 0.33767)
AP0 = [(0.7347, 0.2653), (0.0, 1.0), (0.0001, -0.0770)]
DGAMUT2 = [(0.7347, 0.2653), (0.16, 0.84), (0.09, -0.08)]
REC2020 = [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)]
CAT02 = np.array([[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.0030, 0.0136, 0.9834]])
PROFILES = ("dlog2", "dlog", "hlg")

# Blender's AgX: the look names in its config → file slug.
AGX_LOOKS = {"": "base", "AgX - Punchy": "punchy", "AgX - High Contrast": "high", "AgX - Low Contrast": "low"}

# Other makers' LUTs: (pack, input space, {slug: source file}). Sources are read from <out>/vendor/<pack>/ and the
# results written to <out>/<pack>/. The input space is an OpenColorIO studio-config colour space, or "F-Log2 F-Gamut"
# (below). OpenDRT is a whole config, handled apart.
VENDOR = [
    ("fujifilm", "F-Log2 F-Gamut", {
        slug: f"FLog2_to_{name}_65grid_V.1.00.cube" for slug, name in [
            ("provia", "PROVIA"), ("velvia", "Velvia"), ("astia", "ASTIA"), ("classic-chrome", "CLASSIC-CHROME"),
            ("reala-ace", "REALA-ACE"), ("pro-neg-std", "PRO-Neg.Std"), ("classic-neg", "CLASSIC-Neg."),
            ("eterna", "ETERNA"), ("eterna-bb", "ETERNA-BB"), ("acros", "ACROS"),
        ]
    }),
    ("arri", "ARRI LogC4", {"reveal": "ARRI_LogC4-to-Gamma24_Rec709-D65_v1_65.cube"}),
    ("arri", "ARRI LogC3 (EI800)", {"classic": "ARRI_LogC3-to-Gamma24_Rec709_D65-Classic_33.cube"}),
    ("sony", "S-Log3 S-Gamut3.Cine", {
        "s709": "SL3SG3Ctos709.cube", "cool": "SL3SG3CtoCool_709.cube", "teal-orange": "SL3SG3CtoTealOR_709.cube",
        "vintage": "SL3SG3CtoVintage_709.cube", "warm": "SL3SG3CtoWarm_709.cube",
    }),
]
OPENDRT = "opendrt/OpenDRT_v1.0.0_mini-config_v2/OpenDRT_v1.0.0_mini-config.ocio"
OPENDRT_LOOKS = {"default": "Default", "colorful": "Colorful", "umbra": "Umbra"}

# Fujifilm F-Log2 (data sheet ver.1.0): scene reflectance → full-range code value; 18% grey is 0.391.
FLOG2 = dict(cut1=0.000889, a=5.555556, b=0.064829, c=0.245281, d=0.384316, e=8.799461, f=0.092864)


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


def lin_to_flog2(x):
    k = FLOG2
    return np.where(x >= k["cut1"], k["c"] * np.log10(np.maximum(k["a"] * x + k["b"], 1e-10)) + k["d"], k["e"] * x + k["f"])


def apply(proc, rgb):
    a = np.ascontiguousarray(rgb, dtype=np.float32).copy()
    proc.applyRGB(a)
    return a


def processor(config, transform):
    return config.getProcessor(transform).getDefaultCPUProcessor()


def aces_linear(profile, code):
    if profile == "dlog":
        return apply(processor(CFG, ocio.ColorSpaceTransform(src="D-Log D-Gamut", dst="ACES2065-1")), code)
    if profile == "dlog2":
        return dlog2_to_lin(code) @ to_ap0(DGAMUT2).T
    if profile == "hlg":
        return hlg_to_scene(code) @ to_ap0(REC2020).T
    raise ValueError(profile)


def write_cube(path, title, rgb, n):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {n}\n')
        f.writelines(f"{p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n" for p in np.clip(rgb, 0, 1))
    print(path)


def via(config, transform):
    """An OpenColorIO transform as a function on an array of RGB rows."""
    proc = processor(config, transform)
    return lambda rgb: apply(proc, rgb)


def encoder(space):
    """ACES2065-1 → code values of a vendor LUT's input space."""
    if space == "F-Log2 F-Gamut":  # F-Gamut has BT.2020 primaries and D65 white
        m = np.linalg.inv(to_ap0(REC2020)).T
        return lambda aces: lin_to_flog2(aces @ m)
    return via(CFG, ocio.ColorSpaceTransform(src="ACES2065-1", dst=space))


def renderings(blender, vendor):
    """(relative path template, title, function from ACES2065-1 to Rec.709 BT.1886 display code values)."""
    yield ("{p}-to-rec709-aces2.cube", "ACES 2.0 SDR",
           via(CFG, ocio.DisplayViewTransform(src="ACES2065-1", display=DISPLAY, view="ACES 2.0 - SDR 100 nits (Rec.709)")))
    yield ("{p}-to-rec709-aces1.cube", "ACES 1.0 SDR Video",
           via(CFG_ACES1, ocio.DisplayViewTransform(src="ACES2065-1", display=DISPLAY, view="ACES 1.0 - SDR Video")))
    if blender:
        cfg = ocio.Config.CreateFromFile(str(blender))
        for look, slug in AGX_LOOKS.items():
            if look:
                t = ocio.LookTransform(src="ACES2065-1", dst="AgX Base Rec.1886", looks=look)
            else:
                t = ocio.ColorSpaceTransform(src="ACES2065-1", dst="AgX Base Rec.1886")
            yield (f"agx/{{p}}-{slug}.cube", f"AgX {look.removeprefix('AgX - ') or 'Base'}", via(cfg, t))
    for pack, space, looks in VENDOR:
        enc = encoder(space)
        for slug, file in looks.items():
            src = vendor / pack / file
            if not src.exists():
                print(f"skipping {pack} {slug}: no {src}")
                continue
            lut = via(CFG, ocio.FileTransform(src=str(src), interpolation=ocio.INTERP_TETRAHEDRAL))
            yield (f"{pack}/{{p}}-{slug}.cube", f"{src.stem}, from {space}",
                   lambda aces, enc=enc, lut=lut: lut(np.clip(enc(aces), 0, 1)))
    drt = vendor / OPENDRT
    if not drt.exists():
        print(f"skipping OpenDRT: no {drt}")
        return
    cfg = ocio.Config.CreateFromFile(str(drt))
    for slug, name in OPENDRT_LOOKS.items():
        yield (f"opendrt/{{p}}-{slug}.cube", f"OpenDRT v1.0.0 {name}",
               via(cfg, ocio.DisplayViewTransform(src="ACES 2065-1", display="Rec.1886", view=f"OpenDRT v1.0.0 {name}")))


def find_blender():
    hits = sorted(glob.glob("/Applications/Blender*.app/Contents/Resources/*/datafiles/colormanagement/config.ocio"))
    return Path(hits[-1]) if hits else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", nargs="?", default="~/Library/Application Support/Grade/luts")
    ap.add_argument("--blender", type=Path, default=find_blender(), help="Blender's colormanagement/config.ocio, for AgX")
    ap.add_argument("--vendor", type=Path, help="other makers' LUTs, one folder per pack (default <out>/vendor)")
    ap.add_argument("--size", type=int, default=65)
    args = ap.parse_args()
    out = Path(args.out).expanduser()
    vendor = (args.vendor or out / "vendor").expanduser()
    n = args.size
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # .cube: red varies fastest
    code = np.stack([r, gg, b], axis=-1).reshape(-1, 3)
    aces = {p: aces_linear(p, code) for p in PROFILES}
    if not args.blender:
        print("no Blender config found: skipping AgX (pass --blender)")
    for template, title, render in renderings(args.blender, vendor):
        for p in PROFILES:
            write_cube(out / template.format(p=p), f"{p} to Rec.709, {title}", render(aces[p]), n)


if __name__ == "__main__":
    main()
