"""Deterministic renderer: serves the composition, seeks every frame in headless Chrome, pipes PNGs to ffmpeg.

usage:
  python3 render.py stills 5 20 60        # PNG stills at given seconds -> stills/
  python3 render.py video [out.mp4] [audio.mp3]
  options (both modes): --trace URL --timeline URL --audio FILE
"""
import http.server, os, socketserver, subprocess, sys, threading, functools, urllib.parse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
handler = functools.partial(Quiet, directory=ROOT)
srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

_trace = _timeline = _audio = None
rest = []
it = iter(sys.argv[1:])
for a in it:
    if a in ("--trace", "--timeline", "--audio"):
        v = next(it, None)
        if v is None: sys.exit(f"{a} needs a value")
        if a == "--trace": _trace = v
        elif a == "--timeline": _timeline = v
        else: _audio = v
    else:
        rest.append(a)
_qs = urllib.parse.urlencode({k: v for k, v in (("trace", _trace), ("timeline", _timeline)) if v})
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html" + ("?" + _qs if _qs else "")

def open_page(p):
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    pg.on("console", lambda m: print("[page]", m.text) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: print("[pageerror]", e))
    pg.goto(URL)
    pg.wait_for_function("window.__ready === true", timeout=60000)
    return b, pg

mode = rest[0] if rest else sys.exit("usage: render.py {stills|video} [...]")
with sync_playwright() as p:
    b, pg = open_page(p)
    if mode == "stills":
        os.makedirs(os.path.join(ROOT, "stills"), exist_ok=True)
        for s in rest[1:]:
            pg.evaluate(f"window.__seek({float(s)})")
            pg.screenshot(path=os.path.join(ROOT, "stills", f"t{float(s):06.1f}.png"))
            print("still", s)
    else:
        out = rest[1] if len(rest) > 1 else "adu-walkthrough.mp4"
        audio = _audio or (rest[2] if len(rest) > 2 else None)
        fps, dur = pg.evaluate("window.__fps"), pg.evaluate("window.__duration")
        n = int(round(fps * dur))
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-i", "-"]
        if audio: cmd += ["-i", audio, "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
        ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(n):
            pg.evaluate(f"window.__seek({i / fps})")
            ff.stdin.write(pg.screenshot(type="png"))
            if i % 150 == 0: print(f"frame {i}/{n}", flush=True)
        ff.stdin.close(); ff.wait()
        print("wrote", out)
    b.close()
srv.shutdown()
