"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function RunTabs({ id }: { id: string }) {
  const p = usePathname();
  const t: [string, string][] = [["", "Overview"], ["/rules", "Reading the code"], ["/log", "The agent at work"], ["/verdict", "The answer"], ["/checks", "Checks"], ["/walkthrough", "Walkthrough"]];
  return (
    <nav className="tabs" aria-label="Run">
      {t.map(([s, l]) => { const href = `/runs/${id}${s}`; return <Link key={s} href={href} className={p === href ? "on" : ""}>{l}</Link>; })}
    </nav>
  );
}
