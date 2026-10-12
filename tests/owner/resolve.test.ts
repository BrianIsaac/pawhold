import { describe, expect, it } from "vitest";

import { makeEstimateVersion } from "@/estimate/version";
import { sendEstimate } from "@/money/holds";
import { mintOwnerToken, OWNER_LINK_LIFETIME_MS, ownerLink } from "@/owner/link";
import { resolveOwnerLink } from "@/owner/resolve";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase } from "../support/money";

const SECRET = "a-test-secret-that-is-at-least-32-characters-long";
const MINTED = new Date("2026-10-12T09:00:00.000Z");

describe("resolving an owner's link", () => {
  const { db } = connectTestDatabase();

  /**
   * A case with its estimate sent, and its owner's link.
   *
   * @returns The case and the link.
   */
  async function sentCase() {
    const fixture = await makeDentalCase(db, "Resolve practice");
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
    const link = await ownerLink(
      db,
      { ...fixture, versionId: draft.id },
      { secret: SECRET, now: MINTED },
    );
    return { ...fixture, versionId: draft.id, link };
  }

  it("opens the case and version a valid link names", async () => {
    const sent = await sentCase();

    const resolved = await resolveOwnerLink(db, sent.link.token, {
      secret: SECRET,
      now: new Date(MINTED.getTime() + 60_000),
    });

    expect(resolved).toEqual({
      kind: "open",
      practiceId: sent.practiceId,
      practiceName: "Resolve practice",
      caseId: sent.caseId,
      versionId: sent.versionId,
      expiresAt: sent.link.expiresAt,
    });
  });

  it("asks the practice by name when the link has expired", async () => {
    const sent = await sentCase();

    const resolved = await resolveOwnerLink(db, sent.link.token, {
      secret: SECRET,
      now: new Date(MINTED.getTime() + OWNER_LINK_LIFETIME_MS),
    });

    expect(resolved).toEqual({ kind: "ask_the_practice", practiceName: "Resolve practice" });
  });

  it("asks the practice by no name when the link was changed", async () => {
    const sent = await sentCase();
    const changed = `${sent.link.token.slice(0, 10)}${sent.link.token[10] === "A" ? "B" : "A"}${sent.link.token.slice(11)}`;

    const resolved = await resolveOwnerLink(db, changed, { secret: SECRET, now: MINTED });

    expect(resolved).toEqual({ kind: "ask_the_practice", practiceName: null });
  });

  it("asks the practice by no name when a signed link names no case or no sent version", async () => {
    const sent = await sentCase();
    const unknownCase = mintOwnerToken(
      { caseId: "6f1c1d2e-8a4b-4c3d-9e5f-0a1b2c3d4e5f", versionId: sent.versionId },
      SECRET,
      MINTED,
    );
    const draft = await makeEstimateVersion(db, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      actor: "vet",
      lines: DENTAL_LINES,
    });
    const unsent = mintOwnerToken({ caseId: sent.caseId, versionId: draft.id }, SECRET, MINTED);

    for (const token of [unknownCase, unsent]) {
      expect(await resolveOwnerLink(db, token, { secret: SECRET, now: MINTED })).toEqual({
        kind: "ask_the_practice",
        practiceName: null,
      });
    }
  });
});
