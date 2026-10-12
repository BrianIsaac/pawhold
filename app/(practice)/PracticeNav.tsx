"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./practice.module.css";

/** The practice's places, in the order the header lists them; U8a adds "/day". */
const PLACES = [
  { href: "/today", label: "Today's cases" },
  { href: "/day", label: "The day" },
] as const;

/**
 * The practice's navigation, the current place marked.
 *
 * @returns The navigation.
 */
export function PracticeNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Practice" className={styles.nav}>
      <ul>
        {PLACES.map((place) => (
          <li key={place.href}>
            <Link
              href={place.href}
              className={styles.navLink}
              aria-current={pathname === place.href ? "page" : undefined}
            >
              {place.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
