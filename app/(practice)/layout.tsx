import type { Metadata } from "next";
import type { ReactNode } from "react";

import { currentPracticeSession } from "@/server/practice-session";

import { Wordmark } from "../components/Wordmark";
import { PracticeNav } from "./PracticeNav";
import styles from "./practice.module.css";

export const metadata: Metadata = {
  title: { template: "%s - pawhold", default: "pawhold" },
};

/**
 * The practice's screens: a header naming the practice signed in, the
 * practice's navigation (today's cases; U8a adds the day), and the page.
 *
 * @param props - The page.
 * @param props.children - The page.
 * @returns The practice's shell.
 */
export default async function PracticeLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await currentPracticeSession();
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to the page
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <Wordmark />
            {session ? <span className={styles.practiceName}>{session.practiceName}</span> : null}
          </div>
          {session ? <PracticeNav /> : null}
        </div>
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
