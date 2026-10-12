import { readFileSync } from "node:fs";

import { updateRequest } from "@/agent/update";
import type { ModelRequest } from "@/agent/model";
import type { Executor } from "@/db/client";
import { currentPriceList } from "@/estimate/price-list";
import { caseEstimateVersions } from "@/estimate/version";

import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { WALK_FINDING, WALK_PHOTO_PATH } from "./update-walk-words";

export { WALK_FINDING, WALK_PHOTO_PATH };

/**
 * The update the browser walk adds to the seeded case, and the answer the
 * walks' recorded double gives for it. The answer is written by hand for the
 * walk (no model was asked) and kept to the guardrails a model's answer meets.
 */

/** The answer the double gives: two lines and an explanation in the owner's words. */
export const WALK_UPDATE_ANSWER = {
  lines: [
    {
      code: "DEN-EXT-SG",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "surgical extraction of the carnassial",
      ownerWording: "Removing the infected back tooth",
    },
    {
      code: "MED-ANTIB-TAB",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "Antibiotics to go home",
      ownerWording: "Antibiotic tablets to take home",
    },
  ],
  explanation:
    "Rowan found an infection at the root of one of Bramble's upper back teeth on the X-ray. Rowan recommends removing that tooth surgically, and antibiotic tablets to take home.",
};

/** Who the walk's recorded answer says served it: no model did. */
export const HAND_WRITTEN = "hand-written for the browser walk";

/**
 * The walk's photo as the update sends it.
 *
 * @returns The photo.
 */
export function walkPhoto(): { mediaType: "image/png"; dataBase64: string } {
  return { mediaType: "image/png", dataBase64: readFileSync(WALK_PHOTO_PATH).toString("base64") };
}

/**
 * The model request the walk's update makes on a practice's seeded case: the
 * finding and the photo against the estimate the owner approved.
 *
 * @param db - The database.
 * @param practiceId - A seeded practice.
 * @param caseId - Its showcase case.
 * @returns The request.
 */
export async function walkUpdateRequest(
  db: Executor,
  practiceId: string,
  caseId: string,
): Promise<ModelRequest> {
  const list = (await currentPriceList(db, practiceId))!;
  const [approved] = await caseEstimateVersions(db, practiceId, caseId);
  return updateRequest({
    items: list.items.values(),
    patientName: SHOWCASE_CASE.patientName,
    basedOn: approved!,
    finding: WALK_FINDING,
    photo: walkPhoto(),
  });
}
