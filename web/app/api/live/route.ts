import { liveStatus } from "@/lib/engine";

export async function GET() {
  return Response.json(liveStatus(), { headers: { "cache-control": "no-store" } });
}
