import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { createRecordedModel, memoryRecordedStore, type RecordedStore } from "@/agent/recorded";
import { auditEvent, patientCase } from "@/db/schema";
import { createJudgeSessionHandlers } from "@/judge/session";
import { PracticeError } from "@/practice/errors";
import { approveAndSend, loadCaseView } from "@/practice/estimate";
import { draftUpdateForCase, loadSourcePhoto } from "@/practice/update";

import { seedFictionalPractice } from "../../seed/practice";
import { primeAnswer } from "../support/agent";
import { connectTestDatabase } from "../support/database";
import {
  WALK_FINDING,
  WALK_PHOTO_PATH,
  WALK_UPDATE_ANSWER,
  walkUpdateRequest,
} from "../support/update-walk";

const { db } = connectTestDatabase();
const ORIGIN = "https://pawhold.test";
const PHOTO = readFileSync(WALK_PHOTO_PATH);

let practiceId: string;
let caseId: string;
let store: RecordedStore;

beforeEach(async () => {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  const started = await handlers.POST(
    new Request(`${ORIGIN}/api/judge/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  practiceId = ((await started.json()) as { practiceId: string }).practiceId;
  const [kase] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(eq(patientCase.practiceId, practiceId));
  caseId = kase!.id;
  store = memoryRecordedStore();
  primeAnswer(store, await walkUpdateRequest(db, practiceId, caseId), WALK_UPDATE_ANSWER);
});

/**
 * The agent on the recorded double.
 *
 * @returns The dependencies.
 */
function agent() {
  return { db, model: createRecordedModel(store), draftsPerHour: null };
}

/**
 * Drafts the walk's update on the seeded case.
 *
 * @param sharePhoto - Whether the owner may see the photo.
 * @returns The update.
 */
function draftWalkUpdate(sharePhoto = true) {
  return draftUpdateForCase(agent(), {
    practiceId,
    caseId,
    finding: WALK_FINDING,
    photo: { mediaType: "image/png", bytes: PHOTO },
    sharePhoto,
  });
}

describe("the update", () => {
  it("shows the decline: the update the owner declined, and what stays held", async () => {
    const { update, money } = await loadCaseView(db, practiceId, caseId);

    expect(money.state).toBe("update_declined");
    expect(update.declined?.panel.version.number).toBe(2);
    expect(update.declined?.declinedAt).toBeInstanceOf(Date);
    expect(update.canDraft).toBe(true);
  });

  it("after the owner declines an update, the next builds on what they approved, not on what they declined", async () => {
    const drafted = await draftWalkUpdate();

    expect(drafted.failure).toBeNull();
    expect(drafted.basedOn.number).toBe(1);
    const { update } = await loadCaseView(db, practiceId, caseId);
    expect(update.draft?.panel.version.number).toBe(3);
    expect(update.draft?.basedOn.number).toBe(1);
    expect(update.draft?.panel.version.lines.slice(7).map((line) => line.code)).toEqual([
      "DEN-EXT-SG",
      "MED-ANTIB-TAB",
    ]);
    expect(update.draft?.delta.items.map((item) => [item.code, item.change])).toEqual([
      ["DEN-EXT-SG", "changed"],
      ["MED-ANTIB-TAB", "added"],
    ]);
  });

  it("keeps the finding, its spans, the photo, whether the owner sees it, and the explanation beside the update", async () => {
    await draftWalkUpdate();

    const { update } = await loadCaseView(db, practiceId, caseId);
    const source = update.draft!.panel.source!;
    expect(source.kind).toBe("finding");
    expect(source.text).toBe(WALK_FINDING);
    expect(source.explanation).toBe(WALK_UPDATE_ANSWER.explanation);
    expect(source.photo).toMatchObject({
      mediaType: "image/png",
      bytes: PHOTO.length,
      shared: true,
    });
    expect(update.draft!.panel.spans.map((span) => span.position)).toEqual([8, 9]);
    const photo = await loadSourcePhoto(db, { practiceId, caseId, versionId: source.versionId });
    expect(photo?.bytes.equals(PHOTO)).toBe(true);
  });

  it("gives the trigger check in the Order's words, the increase over what is held", async () => {
    await draftWalkUpdate();

    const { update } = await loadCaseView(db, practiceId, caseId);
    expect(update.draft?.increasePence).toBe(13_000);
    expect(update.draft?.triggerSentence).toBe(
      "This adds £130.00, 14% over the held estimate. The CMA's Order asks for an updated written estimate at 20% or £500.00, whichever is lower: this one does not meet it. pawhold asks the owner either way, because nothing over the hold is charged without their yes.",
    );
  });

  it("refuses a photo that is not the image it says, naming the field", async () => {
    const refused = await draftUpdateForCase(agent(), {
      practiceId,
      caseId,
      finding: WALK_FINDING,
      photo: { mediaType: "image/jpeg", bytes: PHOTO },
      sharePhoto: false,
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PracticeError);
    expect((refused as PracticeError).fields).toHaveProperty("photo");
  });

  it("refuses to show the owner a photo there is none of", async () => {
    const refused = await draftUpdateForCase(agent(), {
      practiceId,
      caseId,
      finding: WALK_FINDING,
      photo: null,
      sharePhoto: true,
    }).catch((error: unknown) => error);

    expect((refused as PracticeError).fields).toHaveProperty("sharePhoto");
  });

  it("is sent as the estimate is: the vet's approval, then the update awaits the owner", async () => {
    await draftWalkUpdate();
    const { update } = await loadCaseView(db, practiceId, caseId);

    const sent = await approveAndSend(db, {
      practiceId,
      versionId: update.draft!.panel.version.id,
    });

    expect(sent.moneyState).toBe("update_awaiting_owner");
    const view = await loadCaseView(db, practiceId, caseId);
    expect(view.update.awaiting?.panel.version.number).toBe(3);
    expect(view.update.awaiting?.increasePence).toBe(13_000);
    const approvals = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.approved")));
    expect(approvals.at(-1)?.detail).toMatchObject({ number: 3, vetName: "Rowan Hale" });
  });
});
