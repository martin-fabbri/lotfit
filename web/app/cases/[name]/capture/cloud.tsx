"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Pt = [number, number];
const FT = 1;

/** The lot cloud (lot frame, feet; x along the front line, y to the rear, z up), with the lot outline, house and the plan's spot. */
export function CloudView({ src, lot, house, spot }: { src: string; lot: Pt[]; house: Pt[]; spot: { fp: Pt[]; pl: { x: number; y: number; rotation?: number } } | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading the cloud…");
  useEffect(() => {
    const el = host.current!;
    const w = el.clientWidth, h = 560;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(w, h); renderer.setClearColor(0x0a0f0d);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(45, w / h, 0.5, 2000);
    // three.js: X = x, Y = z (up), Z = -y
    const toV = (x: number, y: number, z = 0) => new THREE.Vector3(x * FT, z * FT, -y * FT);
    const xs = lot.map((p) => p[0]), ys = lot.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    // the scan covers the back yard: look at it from above the house, toward the back fence
    cam.position.copy(toV(cx - 18, cy - 30, 62)); const ctr = new OrbitControls(cam, renderer.domElement);
    ctr.target.copy(toV(cx, cy + 32, 0)); ctr.update();
    const line = (pts: Pt[], color: number, z = 0.05, dashed = false) => {
      const g = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]].map(([x, y]) => toV(x, y, z)));
      const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.2 }) : new THREE.LineBasicMaterial({ color });
      const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); scene.add(l);
    };
    if (lot.length) line(lot, 0xa2aba5, 0.05, true);
    if (house.length) line(house, 0x7eb6e6, 0.1);
    if (spot) {
      const r = ((spot.pl.rotation ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      line(spot.fp.map(([x, y]) => [spot.pl.x + x * c - y * s, spot.pl.y + x * s + y * c] as Pt), 0x5ec4b0, 0.15);
    }
    let raf = 0, alive = true;
    fetch(src).then((r) => r.arrayBuffer()).then((buf) => {
      if (!alive) return;
      const n = new DataView(buf).getUint32(0, true);
      const xyz = new Float32Array(buf, 4, n * 3);
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[3 * i] = xyz[3 * i]; pos[3 * i + 1] = xyz[3 * i + 2]; pos[3 * i + 2] = -xyz[3 * i + 1];
        // colour by height above ground (ft): ground teal → fences and walls sand → roofline orange
        const z = xyz[3 * i + 2], k = Math.max(0, Math.min(1, (z + 1) / 9));
        col[3 * i] = 0.27 + 0.67 * k; col[3 * i + 1] = 0.72 - 0.12 * k; col[3 * i + 2] = 0.66 - 0.38 * k;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.22, vertexColors: true, sizeAttenuation: true })));
      setStatus(`${n.toLocaleString("en-US")} points · drag to orbit, scroll to zoom`);
    }).catch(() => setStatus("the cloud could not be loaded"));
    const tick = () => { raf = requestAnimationFrame(tick); ctr.update(); renderer.render(scene, cam); };
    tick();
    return () => { alive = false; cancelAnimationFrame(raf); ctr.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, [src, lot, house, spot]);
  return (<div><div ref={host} style={{ width: "100%", height: 560 }} /><div className="tiny muted" style={{ padding: "8px 14px" }}>{status} · colour: height above ground · dashed: lot lines · blue: house · teal: the plan at its spot</div></div>);
}
