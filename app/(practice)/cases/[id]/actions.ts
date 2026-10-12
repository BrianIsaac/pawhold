"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { PracticeError } from "@/practice/errors";
import {
  addDraftLine,
  approveAndSend,
  draftAgainFromWithdrawn,
  draftForCase,
  editDraftLine,
  removeDraftLine,
  withdrawCaseEstimate,
} from "@/practice/estimate";
import { refusalMessage } from "@/practice/messages";
import { draftUpdateForCase } from "@/practice/update";
import { currentPracticeSession } from "@/server/practice-session";
import { database, estimateAgent } from "@/server/runtime";

import { type FormState, formValues } from "../../form-state";

/** What a form says when the visitor's session has gone. */
const SESSION_ENDED = "Your session has ended. Reload the page to start a new one.";

/** What a bound target may name: a case, a version, a line, by id. */
const ids = z.uuid();

/**
 * Runs one of the case page's changes for the signed-in practice, turning a
 * refusal into the form's state and, on success, showing the case afresh.
 * The case id comes bound from the page, so it is checked as an id; the
 * change itself is scoped to the session's practice.
 *
 * @param caseId - The case the form is on.
 * @param values - What was typed, to give back on a refusal.
 * @param change - The change, given the practice's id; it answers whether to give the typed values back.
 * @returns The form's state.
 */
async function onCase(
  caseId: string,
  values: Record<string, string>,
  change: (practiceId: string) => Promise<{ keepValues: boolean } | unknown>,
): Promise<FormState> {
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED, fields: {}, values };
  }
  if (!ids.safeParse(caseId).success) {
    return { message: "That case is not this practice's.", fields: {}, values };
  }
  let kept = false;
  try {
    const result = await change(session.practiceId);
    kept =
      typeof result === "object" &&
      result !== null &&
      "keepValues" in result &&
      result.keepValues === true;
  } catch (error) {
    const message = refusalMessage(error);
    if (message === null) {
      throw error;
    }
    revalidatePath(`/cases/${caseId}`);
    return {
      message,
      fields: error instanceof PracticeError ? error.fields : {},
      values,
    };
  }
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/today");
  return { message: null, fields: {}, values: kept ? values : {} };
}

/**
 * "Draft estimate" (section 6): the agent's draft from the notes.
 *
 * @param caseId - The case.
 * @param _previous - The form's last state.
 * @param form - The notes.
 * @returns The form's state.
 */
export async function draftEstimateAction(
  caseId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const values = formValues(form, ["notes"]);
  if (values.notes!.trim() === "") {
    return { message: null, fields: { notes: "Type or paste your notes first" }, values };
  }
  // A failed draft keeps the lines it had; the notes just typed are given
  // back to the form so they are not lost.
  return onCase(caseId, values, async (practiceId) => {
    const drafted = await draftForCase(estimateAgent(), {
      practiceId,
      caseId,
      notes: values.notes!,
    });
    return { keepValues: drafted.failure !== null };
  });
}

/** The fields of a line's form. */
const LINE_FIELDS = ["quantityLow", "quantityHigh", "dependsOn", "ownerWording"] as const;

/**
 * Saves a line's quantities, condition and wording.
 *
 * @param target - The case, the draft and the line.
 * @param target.caseId - The case.
 * @param target.versionId - The draft.
 * @param target.lineId - The line.
 * @param _previous - The form's last state.
 * @param form - The line's fields.
 * @returns The form's state.
 */
export async function editLineAction(
  target: { caseId: string; versionId: string; lineId: string },
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const values = formValues(form, LINE_FIELDS);
  return onCase(target.caseId, values, (practiceId) =>
    editDraftLine(database().db, {
      practiceId,
      versionId: target.versionId,
      lineId: target.lineId,
      quantityLow: values.quantityLow!,
      quantityHigh: values.quantityHigh!,
      dependsOn: values.dependsOn!,
      ownerWording: values.ownerWording!,
    }),
  );
}

/**
 * Takes a line out of the draft.
 *
 * @param target - The case, the draft and the line.
 * @param target.caseId - The case.
 * @param target.versionId - The draft.
 * @param target.lineId - The line.
 * @returns The form's state.
 */
export async function removeLineAction(target: {
  caseId: string;
  versionId: string;
  lineId: string;
}): Promise<FormState> {
  return onCase(target.caseId, {}, (practiceId) =>
    removeDraftLine(database().db, {
      practiceId,
      versionId: target.versionId,
      lineId: target.lineId,
    }),
  );
}

/**
 * Adds an item from the price list by hand.
 *
 * @param caseId - The case.
 * @param _previous - The form's last state.
 * @param form - The item's code, quantities, condition and wording.
 * @returns The form's state.
 */
export async function addLineAction(
  caseId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const values = formValues(form, ["code", ...LINE_FIELDS]);
  return onCase(caseId, values, (practiceId) =>
    addDraftLine(database().db, {
      practiceId,
      caseId,
      code: values.code!,
      quantityLow: values.quantityLow!,
      quantityHigh: values.quantityHigh!,
      dependsOn: values.dependsOn!,
      ownerWording: values.ownerWording!,
    }),
  );
}

/** What the review dialog showed of the draft it sends. */
const reviewedShape = z.strictObject({
  lowPence: z.int(),
  highPence: z.int(),
  lineIds: z.array(z.uuid()),
});

/**
 * Review and send: the vet's approval of what the review showed and U3's
 * send, then the case with its confirmation.
 *
 * @param target - The case, the draft, which confirmation to show, and what the review showed.
 * @param target.caseId - The case.
 * @param target.versionId - The draft.
 * @param target.sent - Which confirmation to show: the estimate's or the update's.
 * @param target.reviewed - The totals and the lines the review dialog showed.
 * @returns The form's state when refused; otherwise it redirects to the case.
 */
export async function sendAction(target: {
  caseId: string;
  versionId: string;
  sent: "estimate" | "update";
  reviewed: z.input<typeof reviewedShape>;
}): Promise<FormState> {
  const sent = z.enum(["estimate", "update"]).parse(target.sent);
  let sentCase: string | null = null;
  const state = await onCase(target.caseId, {}, async (practiceId) => {
    const answer = await approveAndSend(database().db, {
      practiceId,
      versionId: target.versionId,
      reviewed: reviewedShape.parse(target.reviewed),
    });
    sentCase = answer.version.caseId;
  });
  if (state.message !== null || sentCase === null) {
    return state;
  }
  redirect(`/cases/${sentCase}?sent=${sent}`);
}

/**
 * Withdraws the estimate or the update awaiting the owner, then shows the
 * case with a word that it was withdrawn.
 *
 * @param target - The case, and whether it is the estimate or an update.
 * @param target.caseId - The case.
 * @param target.what - Which is withdrawn.
 * @returns The form's state when refused; otherwise it redirects to the case.
 */
export async function withdrawAction(target: {
  caseId: string;
  what: "estimate" | "update";
}): Promise<FormState> {
  const what = z.enum(["estimate", "update"]).parse(target.what);
  const state = await onCase(target.caseId, {}, (practiceId) =>
    withdrawCaseEstimate(database().db, { practiceId, caseId: target.caseId }),
  );
  if (state.message !== null) {
    return state;
  }
  redirect(`/cases/${target.caseId}?withdrawn=${what}`);
}

/**
 * Starts a new draft from the withdrawn estimate.
 *
 * @param caseId - The case.
 * @returns The form's state.
 */
export async function draftAgainAction(caseId: string): Promise<FormState> {
  return onCase(caseId, {}, (practiceId) =>
    draftAgainFromWithdrawn(database().db, { practiceId, caseId }),
  );
}

/**
 * Drafts an update (section 6): the vet's finding, an optional photo and
 * whether the owner sees it.
 *
 * @param caseId - The case.
 * @param _previous - The form's last state.
 * @param form - The finding, the photo and the checkbox.
 * @returns The form's state.
 */
export async function draftUpdateAction(
  caseId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const values = formValues(form, ["finding", "sharePhoto"]);
  const file = form.get("photo");
  const photo =
    file instanceof File && file.size > 0
      ? { mediaType: file.type, bytes: Buffer.from(await file.arrayBuffer()) }
      : null;
  return onCase(caseId, values, async (practiceId) => {
    const drafted = await draftUpdateForCase(estimateAgent(), {
      practiceId,
      caseId,
      finding: values.finding!,
      photo,
      sharePhoto: values.sharePhoto === "on",
    });
    return { keepValues: drafted.failure !== null };
  });
}
