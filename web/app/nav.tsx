"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: [string, string][] = [["/", "Cases & runs"], ["/rulebook", "Rulebook"]];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      {ITEMS.map(([href, label]) => (
        <Link key={href} href={href} className={(href === "/" ? path === "/" : path.startsWith(href)) ? "on" : ""}>{label}</Link>
      ))}
    </nav>
  );
}
