import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

// The magic link lands here. PKCE (?code=) or token hash (?token_hash=&type=), either way the session cookie is set.
export async function GET(request: NextRequest) {
  const u = request.nextUrl;
  const next = (u.searchParams.get("next") ?? "/").startsWith("/") ? u.searchParams.get("next") ?? "/" : "/";
  const sb = await supabaseServer();
  const code = u.searchParams.get("code");
  const token_hash = u.searchParams.get("token_hash");
  const type = u.searchParams.get("type") as EmailOtpType | null;
  const { error } = code ? await sb.auth.exchangeCodeForSession(code)
    : token_hash && type ? await sb.auth.verifyOtp({ token_hash, type }) : { error: new Error("missing token") };
  const to = u.clone();
  to.search = "";
  if (error) { to.pathname = "/login"; to.searchParams.set("error", "That link has expired or was already used. Ask for a new one."); }
  else to.pathname = next;
  return NextResponse.redirect(to);
}
