import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { loadDischargeView, reviewBill } from "@/discharge/bill";
import { BILL_HEADING, money, NOTHING_HELD } from "@/discharge/wording";
import { moneyChips } from "@/practice/chips";
import { PracticeError } from "@/practice/errors";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { Chip } from "../../../../components/Chip";
import practice from "../../../practice.module.css";
import { SignedOut } from "../../../SignedOut";
import caseStyles from "../case.module.css";
import { CATEGORY_NAMES } from "../EstimateSection";
import { reviewBillAction } from "./actions";
import { BillForm } from "./BillForm";

export const metadata: Metadata = { title: "Discharge" };

export const dynamic = "force-dynamic";

/**
 * Discharge (section 6, the practice: discharge): the itemised bill from the
 * estimate the owner approved, each line's quantity done, work no approved
 * estimate covers refused, and the totals.
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
  const lines = view.groups.flatMap((group) => group.lines);
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
            <dd>{view.case.patientName}</dd>
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
          <div>
            <dt>Held</dt>
            <dd>{money(view.heldPence, view.currency)}</dd>
          </div>
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
        />
      ) : view.signed === null ? (
        <p className={caseStyles.notice}>{NOTHING_HELD}</p>
      ) : null}
    </>
  );
}
