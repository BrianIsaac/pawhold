import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { draftRequest } from "@/agent/draft";
import { MODEL_SETTINGS, requestHash } from "@/agent/model";
import { fileRecordedStore } from "@/agent/recorded";
import { patientCase } from "@/db/schema";
import { currentPriceList } from "@/estimate/price-list";
import { createJudgeSessionHandlers } from "@/judge/session";

import { seedFictionalPractice } from "../../seed/practice";
import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { connectTestDatabase } from "../support/database";
import { HAND_WRITTEN, WALK_UPDATE_ANSWER, walkUpdateRequest } from "../support/update-walk";

const { db } = connectTestDatabase();

/** The walks' draft: plan 3.4's notes, eval set 01, recorded live by U4. */
const PLAN_NOTES = "GA, dental scale and polish, probable two extractions upper PM, pre-op bloods";

/**
 * A seeded judge practice and its showcase case, as the walks start from.
 *
 * @returns The practice and the case.
 */
async function seeded(): Promise<{ practiceId: string; caseId: string }> {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  const started = await handlers.POST(
    new Request("https://pawhold.test/api/judge/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pawhold.test" },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  const { practiceId } = (await started.json()) as { practiceId: string };
  const [kase] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(
      and(
        eq(patientCase.practiceId, practiceId),
        eq(patientCase.patientName, SHOWCASE_CASE.patientName),
      ),
    );
  return { practiceId, caseId: kase!.id };
}

describe("the browser walks' recorded answers (pnpm test:browser)", () => {
  it("hold an answer for the walk's draft: eval set 01's live recording", async () => {
    const { practiceId } = await seeded();
    const list = (await currentPriceList(db, practiceId))!;
    const hash = requestHash(MODEL_SETTINGS, draftRequest(list.items.values(), PLAN_NOTES));

    expect(fileRecordedStore("evals/recorded").get(hash)).toBeDefined();
  });

  it("hold the walk's update answer, written by hand; RECORD_WALK_ANSWERS=1 writes it again", async () => {
    const { practiceId, caseId } = await seeded();
    const request = await walkUpdateRequest(db, practiceId, caseId);
    const hash = requestHash(MODEL_SETTINGS, request);
    const store = fileRecordedStore("tests/browser/recorded");
    if (process.env.RECORD_WALK_ANSWERS === "1") {
      store.put({
        hash,
        job: request.job,
        promptVersion: request.promptVersion,
        model: MODEL_SETTINGS.model,
        reasoningEffort: MODEL_SETTINGS.reasoningEffort,
        servedModel: HAND_WRITTEN,
        text: JSON.stringify(WALK_UPDATE_ANSWER, null, 2),
        recordedAt: "2026-10-12T12:00:00.000Z",
      });
    }

    const recorded = store.get(hash);
    expect(
      recorded,
      "run with RECORD_WALK_ANSWERS=1 after a change to the prompt, list or seed",
    ).toBeDefined();
    expect(JSON.parse(recorded!.text)).toEqual(WALK_UPDATE_ANSWER);
    expect(recorded!.servedModel).toBe(HAND_WRITTEN);
  });
});
