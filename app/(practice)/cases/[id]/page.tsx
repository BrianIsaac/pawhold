import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PracticeError } from "@/practice/errors";
import { loadCaseView } from "@/practice/estimate";
import { sentConfirmation, updateSentConfirmation } from "@/practice/wording";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { ButtonLink } from "../../../components/Button";
import { Chip } from "../../../components/Chip";
import practice from "../../practice.module.css";
import { SignedOut } from "../../SignedOut";
import styles from "./case.module.css";
import { EstimateSection } from "./EstimateSection";
import { UpdateSection } from "./UpdateSection";

export const metadata: Metadata = { title: "Case" };

export const dynamic = "force-dynamic";

/** The states a case can be discharged from (U7 fills the discharge page). */
const DISCHARGEABLE = new Set(["held", "update_declined"]);

/**
 * A case (section 6): the notes beside the drafted estimate, review and send;
 * the update; the timeline. The "Discharge" link goes to U7's page.
 *
 * @param props - The route's parameters and search parameters.
 * @returns The page.
 */
export default async function CasePage(props: PageProps<"/cases/[id]">) {
  const session = await currentPracticeSession();
  if (!session) {
    return <SignedOut />;
  }
  const { id } = await props.params;
  const search = await props.searchParams;
  if (!z.uuid().safeParse(id).success) {
    notFound();
  }
  const view = await loadCaseView(database().db, session.practiceId, id).catch((error: unknown) => {
    if (error instanceof PracticeError && error.reason === "case_not_found") {
      return null;
    }
    throw error;
  });
  if (!view) {
    notFound();
  }
  const first = view.case.ownerFirstName;
  const confirmation =
    search.sent === "estimate" && view.money.state === "awaiting_owner"
      ? sentConfirmation(first)
      : search.sent === "update" && view.money.state === "update_awaiting_owner"
        ? updateSentConfirmation(first)
        : null;

  return (
    <>
      <Link href="/today" className={styles.back}>
        Today&apos;s cases
      </Link>
      <div className={styles.head}>
        <div className={styles.headRow}>
          <h1 className={practice.title}>{view.case.patientName}</h1>
          {DISCHARGEABLE.has(view.money.state) ? (
            <ButtonLink href={`/cases/${view.case.id}/discharge` as Route} variant="secondary">
              Discharge
            </ButtonLink>
          ) : null}
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Owner</dt>
            <dd>{view.case.ownerName}</dd>
          </div>
          <div>
            <dt>Procedure</dt>
            <dd>{view.case.procedure}</dd>
          </div>
          {view.case.vetName ? (
            <div>
              <dt>Vet</dt>
              <dd>{view.case.vetName}</dd>
            </div>
          ) : null}
        </dl>
        <span className={practice.chips} aria-label="Money">
          {view.chips.map((chip) => (
            <Chip key={chip.tone} tone={chip.tone}>
              {chip.label}
            </Chip>
          ))}
        </span>
      </div>
      {confirmation ? (
        <p role="status" className={styles.status}>
          {confirmation}
        </p>
      ) : null}
      <section id="estimate" className={styles.section} aria-labelledby="estimate-title">
        <h2 id="estimate-title" className={styles.sectionTitle}>
          Estimate
        </h2>
        <EstimateSection view={view} />
      </section>
      {view.approved.length > 0 ? (
        <section id="update" className={styles.section} aria-labelledby="update-title">
          <h2 id="update-title" className={styles.sectionTitle}>
            Update
          </h2>
          <UpdateSection view={view} />
        </section>
      ) : null}
    </>
  );
}
