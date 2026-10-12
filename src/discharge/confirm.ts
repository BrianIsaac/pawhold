import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database } from "@/db/client";
import { priceListCode } from "@/estimate/price-list";
import {
  type DischargePlan,
  type DischargeResult,
  dischargeCase,
  signOffBill,
} from "@/money/discharge";
import { MoneyError } from "@/money/errors";
import type { MoneyDependencies } from "@/money/holds";
import { caseHolds } from "@/money/view";
import { PracticeError } from "@/practice/errors";

import { billLines, reviewBill, SEEDED_ID_PREFIX } from "./bill";
import { BILL_CHANGED, SEEDED_HOLDS, SIGNED_ALREADY } from "./wording";

const confirmRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  quantities: z.record(z.uuid(), z.string().max(20)),
  extras: z.array(z.strictObject({ code: priceListCode, quantity: z.string().max(20) })).max(50),
  /** What the page showed the vet when they confirmed. */
  shown: z.strictObject({ billedPence: z.int().min(0) }),
});

export type ConfirmBillRequest = z.input<typeof confirmRequest>;

/**
 * "Confirm and charge {amount}" (section 6), its first half: the bill is
 * reviewed again exactly as the page showed it, refused if it cannot be
 * charged or changed since it was shown, and signed off by U3's
 * `signOffBill` (the bill, its lines and their allocation, kept as signed),
 * with the work no approved estimate covers noted beside it
 * (`bill.work_not_charged`), in one transaction. Nothing is captured here:
 * {@link runDischarge} captures and releases.
 *
 * @param db - The pool.
 * @param request - The practice, the case, the bill as typed and what the page showed.
 * @returns The plan as signed off.
 * @throws PracticeError `request_invalid` with the reason the bill cannot be charged; `stale` when it changed since it was shown or is signed off already.
 */
export async function confirmBill(
  db: Database["db"],
  request: ConfirmBillRequest,
): Promise<DischargePlan> {
  const parsed = confirmRequest.safeParse(request);
  if (!parsed.success) {
    throw new PracticeError("request_invalid", "That bill could not be read.");
  }
  const { practiceId, caseId, quantities, extras, shown } = parsed.data;
  return db.transaction(async (tx) => {
    const review = await reviewBill(tx, { practiceId, caseId, quantities, extras });
    if (review.verdict.kind === "refused") {
      throw new PracticeError("request_invalid", review.verdict.reason);
    }
    if (review.verdict.blocked) {
      throw new PracticeError("request_invalid", review.verdict.blocked);
    }
    if (review.billedPence !== shown.billedPence) {
      throw new PracticeError("stale", BILL_CHANGED);
    }
    let plan: DischargePlan;
    try {
      plan = await signOffBill(tx, {
        practiceId,
        caseId,
        actor: "vet",
        lines: billLines(review.lines),
      });
    } catch (error) {
      if (error instanceof MoneyError && error.reason === "bill_refused") {
        throw new PracticeError("stale", SIGNED_ALREADY);
      }
      throw error;
    }
    if (review.extras.length > 0) {
      await appendAuditEvent(tx, {
        practiceId,
        caseId,
        actor: "vet",
        action: "bill.work_not_charged",
        detail: {
          items: review.extras.map((extra) => ({
            code: extra.code,
            name: extra.name,
            quantity: extra.quantity,
            listPricePence: extra.amountPence,
          })),
        },
      });
    }
    return plan;
  });
}

/**
 * "Confirm and charge {amount}", its second half, and "Resume": U3's
 * `dischargeCase` captures each hold's share, final, in the order the holds
 * were made, then voids what will not be captured; each step lands on its
 * own, so the page shows them as they land, and a discharge stopped part way
 * is resumed by running it again (every step's `PayPal-Request-Id` is the
 * same). A case on holds seeded for the demo is refused before PayPal is
 * asked.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice and the case.
 * @param request.practiceId - The practice.
 * @param request.caseId - The case.
 * @returns What the discharge did.
 * @throws PracticeError `request_invalid` for seeded holds; MoneyError as `dischargeCase` refuses.
 */
export async function runDischarge(
  deps: MoneyDependencies,
  request: { readonly practiceId: string; readonly caseId: string },
): Promise<DischargeResult> {
  const holds = await caseHolds(deps.db, request.caseId);
  if (
    holds.some(
      (one) => one.status === "authorised" && one.paypalOrderId.startsWith(SEEDED_ID_PREFIX),
    )
  ) {
    throw new PracticeError("request_invalid", SEEDED_HOLDS);
  }
  return dischargeCase(deps, request);
}
