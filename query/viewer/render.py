"""Deterministic renderer for the run viewer: serves this folder, seeks every frame in headless Chrome, pipes to ffmpeg.

usage (from query/viewer/):
  python3 render.py stills [--run demo/eug-demo-24x24] 3 15 40 70     # PNG stills -> stills/
  python3 render.py video  [--run demo/eug-demo-24x24] [--fps 30] [out.mp4]
"""
import functools, http.server, os, socketserver, subprocess, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
def opt(name, default):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
run = opt("--run", "demo/eug-demo-24x24")
fps = int(opt("--fps", "30"))
mode = args.pop(0) if args else "stills"

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html?render&run={run}"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    pg.on("pageerror", lambda e: print("[pageerror]", e))
    pg.on("console", lambda m: print("[page]", m.text) if m.type in ("error", "warning") else None)
    pg.goto(URL)
    pg.wait_for_function("window.__ready === true", timeout=60000)
    pg.evaluate("document.fonts.ready")
    if mode == "stills":
        os.makedirs(os.path.join(ROOT, "stills"), exist_ok=True)
        print("duration", pg.evaluate("window.__duration"))
        for s in args:
            pg.evaluate(f"window.__seek({float(s)})")
            pg.screenshot(path=os.path.join(ROOT, "stills", f"t{float(s):06.1f}.png"))
            print("still", s)
    else:
        out = args[0] if args else "run-viewer.mp4"
        dur = pg.evaluate("window.__duration"); n = int(round(fps * dur))
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                               "-movflags", "+faststart", out], stdin=subprocess.PIPE)
        for i in range(n):
            pg.evaluate(f"window.__seek({i / fps})")
            ff.stdin.write(pg.screenshot(type="png"))
            if i % 300 == 0: print(f"frame {i}/{n}", flush=True)
        ff.stdin.close(); ff.wait(); print("wrote", out, f"{dur:.1f}s")
    b.close()
srv.shutdown()
