export default async function CheckEmail({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return (
    <section className="auth">
      <div className="auth-card">
        <div className="wm big">Lot<b>Fit</b></div>
        <h1>Check your email</h1>
        <p className="muted">We sent a sign-in link to <b>{email ?? "your address"}</b>. Open it on this device to continue.</p>
      </div>
    </section>
  );
}
