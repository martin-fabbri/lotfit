import type { Metadata } from "next";
import { Public_Sans, IBM_Plex_Mono } from "next/font/google";
import { currentUser } from "@/lib/supabase/server";
import { Nav } from "./nav";
import "./globals.css";

const sans = Public_Sans({ subsets: ["latin"], variable: "--font-sans", weight: ["400", "500", "600", "700", "800"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "LotFit",
  description: "Does a backyard cottage fit on this lot? Every number traced to its code clause. Meta Global AI Developer Hackathon entry.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="top">
          <a href="/" className="wm" aria-label="LotFit home">Lot<b>Fit</b></a>
          {user ? <Nav /> : null}
          <span className="entry">Meta Global AI Developer Hackathon · entry</span>
          {user && user.email !== "local" ? (
            <form action="/auth/signout" method="post" className="who"><span>{user.email}</span><button type="submit">Sign out</button></form>
          ) : null}
        </header>
        <main>{children}</main>
        <footer><span>Models propose. Deterministic code decides.</span><span>Pre-feasibility only · not a permit decision</span></footer>
      </body>
    </html>
  );
}
