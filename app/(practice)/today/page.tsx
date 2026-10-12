import type { Metadata } from "next";
import Link from "next/link";

import { todaysCases } from "@/practice/cases";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { Chip } from "../../components/Chip";
import { LinkPending } from "../../components/LinkPending";
import { List, ListRow } from "../../components/List";
import styles from "../practice.module.css";
import { SignedOut } from "../SignedOut";
import { NewCaseDialog } from "./NewCaseDialog";

export const metadata: Metadata = { title: "Today's cases" };

export const dynamic = "force-dynamic";

/** Section 6's columns for today's cases. */
const COLUMNS = ["Patient", "Owner", "Procedure", "Money", "Next"] as const;

/**
 * Today's cases (section 6): each case with its money chips in the board's
 * colours and the next thing to do; the patient's name opens the case.
 *
 * @returns The page.
 */
export default async function TodayPage() {
  const session = await currentPracticeSession();
  if (!session) {
    return <SignedOut />;
  }
  const cases = await todaysCases(database().db, session.practiceId);
  const lastVet = cases.find((kase) => kase.vetName !== null)?.vetName ?? "";
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.title}>Today&apos;s cases</h1>
        <NewCaseDialog defaultVet={lastVet} />
      </div>
      <List
        label="Today's cases"
        columns={COLUMNS}
        template="minmax(7rem, 0.8fr) minmax(8rem, 1fr) minmax(9rem, 1.1fr) minmax(17rem, 1.6fr) minmax(12rem, 1.4fr)"
        empty="No cases yet. Open one to draft its estimate."
      >
        {cases.map((kase) => (
          <ListRow
            key={kase.id}
            cells={[
              {
                column: "Patient",
                content: (
                  <Link href={`/cases/${kase.id}`} className={styles.patientLink}>
                    {kase.patientName}
                    <LinkPending />
                  </Link>
                ),
              },
              { column: "Owner", content: kase.ownerName },
              { column: "Procedure", content: kase.procedure },
              {
                column: "Money",
                content: (
                  <span className={styles.chips}>
                    {kase.chips.map((chip) => (
                      <Chip key={chip.tone} tone={chip.tone}>
                        {chip.label}
                      </Chip>
                    ))}
                  </span>
                ),
              },
              { column: "Next", content: kase.next },
            ]}
          />
        ))}
      </List>
    </>
  );
}
