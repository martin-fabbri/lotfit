import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function authConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// A Supabase client bound to the request's cookies (Server Components, Server Actions, Route Handlers).
// Cookie writes fail quietly in Server Components; proxy.ts refreshes the session cookie.
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { for (const { name, value, options } of list) store.set(name, value, options); } catch {}
      },
    },
  });
}

/** The signed-in user's email, or null. Without Supabase configured (local development only) the app is open. */
export async function currentUser(): Promise<{ email: string } | null> {
  if (!authConfigured()) return process.env.NODE_ENV === "development" ? { email: "local" } : null;
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  return data.user?.email ? { email: data.user.email } : null;
}
