# Whiteboard explainer

Source of the silent, captioned video in `docs/assets/synthetick-explainer.mp4` (about 80 seconds) and its animated preview `docs/assets/synthetick-explainer.gif`.

- `script.json`: one caption per line, one scene per board.
- `scenes.js`: the drawings, timed to the captions.
- `silent_timeline.py`: gives each caption a reading time from its word count and writes `timeline.json` plus a silent audio placeholder. No voice of any kind is used, so the video carries no text-to-speech licence terms.
- `config.json`, `brief.md`: size, palette, and the brief the video was made from.

Made with [whiteboard-video](https://github.com/Matteoikarieth96/whiteboard-video-skill), an open-source skill for Claude Code, which draws the scenes in headless Chrome and renders the frames with ffmpeg; the published file has no audio track.
To change it: edit `script.json` or `scenes.js`, run `python3 silent_timeline.py`, render again, and strip the audio track with `ffmpeg -i in.mp4 -map 0:v -c:v copy -an out.mp4`.
