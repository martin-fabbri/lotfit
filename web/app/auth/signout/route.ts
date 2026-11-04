import { NextResponse, type NextRequest } from "next/server";
import { authConfigured, supabaseServer } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  if (authConfigured()) await (await supabaseServer()).auth.signOut();
  const to = request.nextUrl.clone(); to.pathname = "/login"; to.search = "";
  return NextResponse.redirect(to, { status: 303 });
}
