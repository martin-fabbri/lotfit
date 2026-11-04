# Narrate a run

Four commands, in order, with `<run_dir>` holding `trace.json` and `report.json`:

1. `node ../../src/run-narration.mts <run_dir>` — Muse Spark writes one line per beat,
   code checks every line, writes `narration.json`.
2. `node voice.mjs <run_dir>` — one voice reads the lines, writes
   `narration/<beatId>.mp3` + `.json` (cached by text).
3. `node timeline.mjs <run_dir>` — words with times, writes `timeline.json`.
4. `node mix.mjs <run_dir>` — lays the beats end to end, writes `narration.mp3`.

Then `python3 ../render.py video walkthrough.mp4 --trace <trace-url> --timeline <timeline-url>
--audio narration.mp3` renders the walkthrough.
