"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { openCase } from "@/practice/cases";
import { PracticeError } from "@/practice/errors";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { type FormState, formText, formValues } from "./form-state";

/** What a form says when the visitor's session has gone. */
const SESSION_ENDED = "Your session has ended. Reload the page to start a new one.";

/**
 * Opens a case from today's "New case" form and goes to it.
 *
 * @param _previous - The form's last state.
 * @param form - The patient and its species, the owner, the procedure and the vet.
 * @returns The form's state when a field is at fault; otherwise it redirects to the case.
 */
export async function openCaseAction(_previous: FormState, form: FormData): Promise<FormState> {
  const values = formValues(form, ["patientName", "species", "ownerName", "procedure", "vetName"]);
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED, fields: {}, values };
  }
  let caseId: string;
  try {
    caseId = await openCase(database().db, {
      practiceId: session.practiceId,
      patientName: formText(form, "patientName"),
      species: formText(form, "species"),
      ownerName: formText(form, "ownerName"),
      procedure: formText(form, "procedure"),
      vetName: formText(form, "vetName"),
    });
  } catch (error) {
    if (error instanceof PracticeError) {
      return { message: "Check the fields marked below.", fields: error.fields, values };
    }
    throw error;
  }
  revalidatePath("/today");
  redirect(`/cases/${caseId}`);
}
