import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { loadDischargeView, reviewBill, type SignedBill } from "@/discharge/bill";
import { dischargeProgress, type NotedWork, progressJson } from "@/discharge/progress";
import { BILL_HEADING, money, NOT_ON_ESTIMATE, NOTHING_HELD } from "@/discharge/wording";
import type { CurrencyCode } from "@/money/currency";
import { moneyChips } from "@/practice/chips";
import { PracticeError } from "@/practice/errors";
import { withSpecies } from "@/practice/species";
import { type PracticeClock, practiceClock } from "@/practice/time";
import { scheduleSettings } from "@/schedule/settings";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { Chip } from "../../../../components/Chip";
import practice from "../../../practice.module.css";
import { SignedOut } from "../../../SignedOut";
import caseStyles from "../case.module.css";
import { CATEGORY_NAMES } from "../EstimateSection";
import { confirmDischargeAction, resumeDischargeAction, reviewBillAction } from "./actions";
import { BillForm } from "./BillForm";
import { DischargeProgressPanel } from "./DischargeProgressPanel";
import styles from "./discharge.module.css";

export const metadata: Metadata = { title: "Discharge" };

export const dynamic = "force-dynamic";

/**
 * The bill as signed off: its lines, the total, and the work noted but not charged.
 *
 * @param props - The bill, the work noted and the currency.
 * @param props.signed - The bill.
 * @param props.work - The work noted, not charged.
 * @param props.currency - The case's currency.
 * @param props.clock - The practice's clock.
 * @returns The panel.
 */
function SignedBillPanel({
  signed,
  work,
  currency,
  clock,
}: {
  signed: SignedBill;
  work: readonly NotedWork[];
  currency: CurrencyCode;
  clock: PracticeClock;
}) {
  return (
    <section className={caseStyles.panel} aria-labelledby="signed-bill-title">
      <h2 id="signed-bill-title" className={caseStyles.panelTitle}>
        Signed off {clock.day(signed.signedOffAt)} at {clock.minute(signed.signedOffAt)}
      </h2>
      <ul className={caseStyles.review}>
        {signed.lines.map((line) => (
          <li key={line.estimateLineId} className={caseStyles.reviewLine}>
            <span>
              {line.name}
              {line.quantity > 1
                ? `, ${line.quantity} at ${money(line.unitPricePence, currency)}`
                : ""}
            </span>
            <span>{money(line.amountPence, currency)}</span>
          </li>
        ))}
      </ul>
      <p className={caseStyles.total}>Total {money(signed.totalPence, currency)}</p>
      {work.length > 0 ? (
        <div className={styles.work}>
          <h3 className={caseStyles.subTitle}>Work not on an approved estimate, not charged</h3>
          <ul className={caseStyles.review}>
            {work.map((one) => (
              <li key={one.code} className={caseStyles.reviewLine}>
                <span>
                  {one.name}, {one.quantity} done
                </span>
                <span>Not charged</span>
              </li>
            ))}
          </ul>
          <p className={caseStyles.muted}>{NOT_ON_ESTIMATE}</p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Discharge (section 6, the practice: discharge): the itemised bill from the
 * estimate the owner approved, each line's quantity done, work no approved
 * estimate covers refused, the totals and the allocation; then, confirmed,
 * each hold's capture and release as they land and PayPal's tick on each.
 *
 * @param props - The route's parameters.
 * @returns The page.
 */
export default async function DischargePage(props: PageProps<"/cases/[id]/discharge">) {
  const session = await currentPracticeSession();
  if (!session) {
    return <SignedOut />;
  }
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) {
    notFound();
  }
  const db = database().db;
  const view = await loadDischargeView(db, session.practiceId, id).catch((error: unknown) => {
    if (error instanceof PracticeError && error.reason === "case_not_found") {
      return null;
    }
    throw error;
  });
  if (!view) {
    notFound();
  }
  const { timeZone } = await scheduleSettings(db, session.practiceId);
  const lines = view.groups.flatMap((group) => group.lines);
  const progress = view.signed ? await dischargeProgress(db, session.practiceId, id) : null;
  const initial =
    view.signed === null && lines.length > 0
      ? await reviewBill(db, {
          practiceId: session.practiceId,
          caseId: id,
          quantities: Object.fromEntries(
            lines.map((line) => [line.estimateLineId, String(line.quantityLow)]),
          ),
          extras: [],
        })
      : null;

  return (
    <>
      <Link href={`/cases/${view.case.id}` as Route} className={caseStyles.back}>
        {view.case.patientName}&apos;s case
      </Link>
      <div className={caseStyles.head}>
        <h1 className={practice.title}>{BILL_HEADING}</h1>
        <dl className={caseStyles.facts}>
          <div>
            <dt>Patient</dt>
            <dd>{withSpecies(view.case.patientName, view.case.species)}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{view.case.ownerName}</dd>
          </div>
          {view.case.vetName ? (
            <div>
              <dt>Vet</dt>
              <dd>{view.case.vetName}</dd>
            </div>
          ) : null}
          {view.signed === null && view.money.state !== "held" ? (
            <div>
              <dt>Held</dt>
              <dd>{money(view.heldPence, view.currency)}</dd>
            </div>
          ) : null}
        </dl>
        <span className={practice.chips}>
          {moneyChips(view.money).map((chip) => (
            <Chip key={chip.tone} tone={chip.tone}>
              {chip.label}
            </Chip>
          ))}
        </span>
      </div>
      {initial ? (
        <BillForm
          key={lines.map((line) => line.estimateLineId).join()}
          caseId={view.case.id}
          currency={view.currency}
          groups={view.groups}
          unlisted={view.unlisted.map((group) => ({
            label: CATEGORY_NAMES[group.category],
            options: group.items.map((item) => ({
              value: item.code,
              label: `${item.name} (${item.code}), ${money(item.unitPricePence, view.currency)} per ${item.unit}`,
            })),
          }))}
          initial={initial}
          review={reviewBillAction}
          confirm={confirmDischargeAction}
        />
      ) : view.signed && progress ? (
        <div className={styles.bill}>
          <DischargeProgressPanel
            caseId={view.case.id}
            ownerFirstName={view.case.ownerFirstName}
            timeZone={timeZone}
            initial={progressJson(progress)}
            resume={resumeDischargeAction.bind(null, view.case.id)}
          />
          <SignedBillPanel
            signed={view.signed}
            work={progress.work}
            currency={view.currency}
            clock={practiceClock(timeZone)}
          />
        </div>
      ) : (
        <p className={caseStyles.notice}>{NOTHING_HELD}</p>
      )}
    </>
  );
}
