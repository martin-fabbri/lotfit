"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authConfigured, supabaseServer } from "@/lib/supabase/server";

// Sends a magic link. Supabase creates the account on first sign-in; the link signs the person in on this host.
export async function sendMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = String(formData.get("next") ?? "/");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect(`/login?error=${encodeURIComponent("Enter a valid email.")}`);
  if (!authConfigured()) redirect(`/login?error=${encodeURIComponent("Sign-in is not configured on this host.")}`);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const sb = await supabaseServer();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next.startsWith("/") ? next : "/")}` },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect(`/auth/check-email?email=${encodeURIComponent(email)}`);
}
