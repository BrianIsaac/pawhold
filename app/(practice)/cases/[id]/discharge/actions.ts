"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { type BillReview, reviewBill } from "@/discharge/bill";
import { confirmBill, runDischarge } from "@/discharge/confirm";
import { dischargeRefusal, PAYPAL_NOT_SET_UP } from "@/discharge/wording";
import { MoneyError } from "@/money/errors";
import { refusalMessage } from "@/practice/messages";
import { currentPracticeSession } from "@/server/practice-session";
import { database, paypalClient } from "@/server/runtime";

/** What a discharge action says when the visitor's session has gone. */
const SESSION_ENDED = "Your session has ended. Reload the page to start a new one.";

/** The bill as the page holds it: each line's quantity as typed, and the work noted. */
const billInput = z.strictObject({
  quantities: z.record(z.string(), z.string()),
  extras: z.array(z.strictObject({ code: z.string(), quantity: z.string() })),
});

export type BillInput = z.input<typeof billInput>;

/** The review of a bill, or why it could not be reviewed. */
export type ReviewAnswer =
  | { readonly review: BillReview; readonly message?: never }
  | { readonly message: string; readonly review?: never };

/**
 * Reviews the bill as typed for the signed-in practice, writing nothing: the
 * page asks again whenever a quantity or the work noted changes.
 *
 * @param caseId - The case, bound by the page.
 * @param input - The quantities and the work noted.
 * @returns The review, or the refusal in the vet's words.
 */
export async function reviewBillAction(caseId: string, input: BillInput): Promise<ReviewAnswer> {
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED };
  }
  if (!z.uuid().safeParse(caseId).success) {
    return { message: "That case is not this practice's." };
  }
  const bill = billInput.safeParse(input);
  if (!bill.success) {
    return { message: "That bill could not be read." };
  }
  try {
    const review = await reviewBill(database().db, {
      practiceId: session.practiceId,
      caseId,
      ...bill.data,
    });
    return { review };
  } catch (error) {
    const message = refusalMessage(error);
    if (message === null) {
      throw error;
    }
    return { message };
  }
}

/** What a confirm or a resume answers when it does not move the page on. */
export interface DischargeAnswer {
  readonly message: string | null;
}

/**
 * The words for a refusal of a discharge step: the practice's own refusals,
 * then PayPal's.
 *
 * @param error - What was thrown.
 * @returns The sentence, or null when the error is not a refusal.
 */
function dischargeMessage(error: unknown): string | null {
  if (error instanceof MoneyError) {
    return dischargeRefusal(error.reason, error.issues);
  }
  return refusalMessage(error);
}

/**
 * "Confirm and charge {amount}" (section 6): the bill is signed off as the
 * page showed it, then the page shows the discharge while U3's steps land
 * one by one after the answer (each capture and release in its own
 * transaction, on PayPal's answer). A discharge that stops part way is shown
 * as stalled, to resume, and the hourly job resumes it after ten minutes.
 *
 * @param caseId - The case, bound by the page.
 * @param input - The quantities and the work noted, as the page holds them.
 * @param shown - What the page showed the vet: the bill's total.
 * @param shown.billedPence - The bill's total.
 * @returns The refusal in the vet's words; otherwise it redirects to the discharge.
 */
export async function confirmDischargeAction(
  caseId: string,
  input: BillInput,
  shown: { billedPence: number },
): Promise<DischargeAnswer> {
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED };
  }
  if (!z.uuid().safeParse(caseId).success) {
    return { message: "That case is not this practice's." };
  }
  const bill = billInput.safeParse(input);
  const total = z.strictObject({ billedPence: z.int().min(0) }).safeParse(shown);
  if (!bill.success || !total.success) {
    return { message: "That bill could not be read." };
  }
  const paypal = paypalClient();
  if (!paypal) {
    return { message: PAYPAL_NOT_SET_UP };
  }
  const db = database().db;
  const target = { practiceId: session.practiceId, caseId };
  try {
    await confirmBill(db, { ...target, ...bill.data, shown: total.data });
  } catch (error) {
    const message = dischargeMessage(error);
    if (message === null) {
      throw error;
    }
    return { message };
  }
  after(async () => {
    try {
      await runDischarge({ db, paypal }, target);
    } catch (error) {
      // The page shows the stall from the trail and offers to resume it.
      console.error("pawhold: a discharge stopped part way", {
        caseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/today");
  redirect(`/cases/${caseId}/discharge`);
}

/**
 * "Resume": runs the stopped discharge again to its end. Every step's
 * `PayPal-Request-Id` is the one it was first sent with, so nothing is
 * captured or released twice.
 *
 * @param caseId - The case, bound by the page.
 * @returns The refusal in the vet's words; otherwise it redirects to the discharge.
 */
export async function resumeDischargeAction(caseId: string): Promise<DischargeAnswer> {
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED };
  }
  if (!z.uuid().safeParse(caseId).success) {
    return { message: "That case is not this practice's." };
  }
  const paypal = paypalClient();
  if (!paypal) {
    return { message: PAYPAL_NOT_SET_UP };
  }
  try {
    await runDischarge({ db: database().db, paypal }, { practiceId: session.practiceId, caseId });
  } catch (error) {
    const message = dischargeMessage(error);
    if (message === null) {
      throw error;
    }
    revalidatePath(`/cases/${caseId}/discharge`);
    return { message };
  }
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/today");
  redirect(`/cases/${caseId}/discharge`);
}
