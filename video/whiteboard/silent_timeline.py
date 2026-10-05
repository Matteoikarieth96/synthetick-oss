#!/usr/bin/env python3
"""Build timeline.json and a silent narration.wav for a captions-only video.

No text-to-speech is used: each caption gets a reading time based on its word
count, so the drawings stay in sync with the captions and the published video
contains no synthetic or recorded voice.
"""
import json, os, wave, array

SR = 24000
project = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(project, "config.json")))
script = json.load(open(os.path.join(project, "script.json")))
fps = cfg.get("fps", 30)
lead, gap, tail, hold = cfg.get("lead", .35), cfg.get("gap", .22), cfg.get("tail", .55), cfg.get("endHold", .8)

def reading_time(text):
    # About 2.8 words per second plus a short settle, never under 1.8 seconds.
    return max(1.8, 0.5 + len(text.split()) / 2.8)

t, scenes = 0.0, []
for si, sc in enumerate(script):
    s0, lines = t, []
    t += lead
    for li, ln in enumerate(sc["lines"]):
        d = reading_time(ln["t"])
        lines.append({"text": ln["t"], "start": round(t, 3), "end": round(t + d, 3)})
        t += d + (gap if li < len(sc["lines"]) - 1 else 0)
    t += tail + (hold if si == len(script) - 1 else 0)
    t = round(t * fps) / fps
    scenes.append({"id": sc["id"], "start": round(s0, 3), "end": round(t, 3), "lines": lines})

w = wave.open(os.path.join(project, "narration.wav"), "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
w.writeframes(array.array("h", [0] * int(t * SR)).tobytes()); w.close()
json.dump({"total": t, "scenes": scenes}, open(os.path.join(project, "timeline.json"), "w"), indent=1)
print(f"total {t:.2f}s")
for s in scenes:
    print(f"  {s['id']:<10} {s['start']:7.2f} -> {s['end']:7.2f}  ({s['end'] - s['start']:.2f}s)")
