import { runFile } from "@/lib/records";

const TYPES: Record<string, string> = { json: "application/json", jsonl: "application/x-ndjson", mp3: "audio/mpeg" };

// A run's own files (events, report, trace…), behind the session check in proxy.ts.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const b = runFile(id, file);
  if (!b) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(b), { headers: { "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "no-store" } });
}
