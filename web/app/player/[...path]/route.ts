import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { PLAYER } from "@/lib/paths";

// The 3D walkthrough player (query/player), served as is. It loads three.js and its fonts from a pinned CDN.
const ALLOWED = new Set(["index.html", "scene.js", "summary.js"]);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8" };

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const rel = (await params).path.join("/");
  const f = normalize(join(PLAYER, rel));
  if (!ALLOWED.has(rel) || !f.startsWith(PLAYER) || !existsSync(/*turbopackIgnore: true*/ f)) return new Response("not found", { status: 404 });
  return new Response(readFileSync(/*turbopackIgnore: true*/ f), { headers: { "content-type": TYPES[rel.split(".").pop() ?? ""] ?? "text/plain" } });
}
