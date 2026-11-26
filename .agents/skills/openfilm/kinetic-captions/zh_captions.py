"""A translated kinetic-captions file from the original's captions.json: the same phrases in the same places, each
chunk shown on the moment of the original word it stands for. Spec per phrase: lines of "chunk/size@anchor", anchor
being one of that phrase's original words (matched in order, so anchors never run backwards); * = emphasis.
usage: build(en_json, spec, out_json, out_vtt)"""
import json, re, os
SIZES = {"s": 60, "m": 120, "l": 180, "xl": 240}   # a strict grid: multiples of one 60 px square
key = lambda w: re.sub(r"[^a-z']", "", w.lower())

def ts(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

def build(en_json, spec, out_json, out_vtt=None):
    en = json.load(open(en_json)); assert len(en) == len(spec), (len(en), len(spec))
    out = []
    for p, item in zip(en, spec):
        place, lines = item if isinstance(item, tuple) else ({}, item)   # (place changes, e.g. {"vertical": True}, lines)
        p = {**p, **place}
        for side in ("left", "right"):
            if side in place: p.pop("right" if side == "left" else "left", None)
        for side in ("top", "bottom"):
            if side in place: p.pop("bottom" if side == "top" else "top", None)
        words = [w for r in p["lines"] for w in r]; k = 0; rows = []
        for line in lines:
            row = []
            for tok in line.split():
                body, anchor = tok.rsplit("@", 1); text, size = body.rsplit("/", 1)
                em = text.startswith("*"); text = text.lstrip("*")
                if anchor.endswith("+"): anchor = anchor[:-1]; k += 1   # "money+": the next time that word is said
                while k < len(words) and key(words[k]["text"]) != key(anchor): k += 1
                assert k < len(words), ("anchor not in phrase, or out of order", anchor, [w["text"] for w in words])
                w = words[k]
                row.append({"text": text, "t": w["t"], **({"end": w["end"]} if "end" in w else {}), "size": SIZES.get(size) or float(size), "em": em})
            rows.append(row)
        out.append({**{x: v for x, v in p.items() if x != "lines"}, "lines": rows})
    json.dump(out, open(out_json, "w"), ensure_ascii=False, indent=1)
    if out_vtt:   # the same words as subtitles, a cue per phrase, on the source file's own time (it is that file's transcript)
        html = open(os.path.join(os.path.dirname(out_json), "film.html")).read()
        clips = [(float(a), float(b), float(at)) for a, b, at in re.findall(r'<video id="[^"]+" src="[^#]+#t=([\d.]+),([\d.]+)" at="([\d.]+)"', html)]
        lines = ["WEBVTT", "", "NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.", ""]
        for p in out:
            a, b, at = next(c for c in clips if c[2] - 1e-6 <= p["start"] < c[2] + (c[1] - c[0]))
            s0 = a + p["start"] - at; s1 = min(b, a + p["end"] - at)
            lines += [f"{ts(s0)} --> {ts(s1)}", "".join(w["text"] for r in p["lines"] for w in r), ""]
        open(out_vtt, "w").write("\n".join(lines))
    print("phrases", len(out))
