import { sendMagicLink } from "./actions";

export const metadata = { title: "Sign in · LotFit" };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <section className="auth">
      <div className="auth-card">
        <div className="wm big">Lot<b>Fit</b></div>
        <p className="muted">Does a backyard cottage fit on this lot? Sign in with your email: we send you a link, no password.</p>
        <form action={sendMagicLink} className="stack">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          <input type="hidden" name="next" value={sp.next ?? "/"} />
          <button type="submit" className="btn primary">Send me a sign-in link</button>
        </form>
        {sp.error ? <p className="err" role="alert">{sp.error}</p> : null}
        <p className="tiny muted">Meta Global AI Developer Hackathon entry · pre-feasibility only, not a permit decision.</p>
      </div>
    </section>
  );
}
