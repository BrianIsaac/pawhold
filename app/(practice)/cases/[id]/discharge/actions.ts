"use server";

import { z } from "zod";

import { type BillReview, reviewBill } from "@/discharge/bill";
import { refusalMessage } from "@/practice/messages";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

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
