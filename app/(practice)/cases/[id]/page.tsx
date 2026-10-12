import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { caseMoney } from "@/money/view";
import { moneyChips } from "@/practice/chips";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { Chip } from "../../../components/Chip";
import styles from "../../practice.module.css";
import { SignedOut } from "../../SignedOut";

export const metadata: Metadata = { title: "Case" };

export const dynamic = "force-dynamic";

/**
 * A case: its patient, owner and money.
 *
 * @param props - The route's parameters.
 * @returns The page.
 */
export default async function CasePage(props: PageProps<"/cases/[id]">) {
  const session = await currentPracticeSession();
  if (!session) {
    return <SignedOut />;
  }
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) {
    notFound();
  }
  const money = await caseMoney(database().db, session.practiceId, id).catch(() => null);
  if (!money) {
    notFound();
  }
  return (
    <div className={styles.pageHead}>
      <h1 className={styles.title}>Case</h1>
      <span className={styles.chips}>
        {moneyChips(money).map((chip) => (
          <Chip key={chip.tone} tone={chip.tone}>
            {chip.label}
          </Chip>
        ))}
      </span>
    </div>
  );
}
