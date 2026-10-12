import { describe, expect, it } from "vitest";

import { makeEstimateVersion } from "@/estimate/version";
import { sendEstimate } from "@/money/holds";
import {
  OWNER_LINK_LIFETIME_MS,
  OwnerLinkError,
  mintOwnerToken,
  ownerLink,
  verifyOwnerToken,
} from "@/owner/link";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase } from "../support/money";

const SECRET = "a-test-secret-that-is-at-least-32-characters-long";
const CASE_ID = "6f1c1d2e-8a4b-4c3d-9e5f-0a1b2c3d4e5f";
const VERSION_ID = "0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
const MINTED = new Date("2026-10-12T09:00:00.000Z");

/**
 * Flips one character of a token to another of the same alphabet.
 *
 * @param token - The token.
 * @param at - Which character.
 * @returns The changed token.
 */
function flip(token: string, at: number): string {
  const swapped = token[at] === "A" ? "B" : "A";
  return `${token.slice(0, at)}${swapped}${token.slice(at + 1)}`;
}

describe("the owner's link token", () => {
  it("verifies as minted, naming the case and the sent version, for 14 days", () => {
    const token = mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, SECRET, MINTED);

    const check = verifyOwnerToken(token, SECRET, new Date(MINTED.getTime() + 60_000));

    expect(check).toEqual({
      status: "valid",
      caseId: CASE_ID,
      versionId: VERSION_ID,
      expiresAt: new Date(MINTED.getTime() + OWNER_LINK_LIFETIME_MS),
    });
    expect(OWNER_LINK_LIFETIME_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("is short enough for a text message and safe in a URL path", () => {
    const token = mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, SECRET, MINTED);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(96);
  });

  it("is expired from the moment its 14 days end, still naming its case", () => {
    const token = mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, SECRET, MINTED);
    const end = new Date(MINTED.getTime() + OWNER_LINK_LIFETIME_MS);

    expect(verifyOwnerToken(token, SECRET, new Date(end.getTime() - 1_000)).status).toBe("valid");
    expect(verifyOwnerToken(token, SECRET, end)).toEqual({
      status: "expired",
      caseId: CASE_ID,
      versionId: VERSION_ID,
      expiresAt: end,
    });
  });

  it("is refused when any character is changed", () => {
    const token = mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, SECRET, MINTED);
    const now = new Date(MINTED.getTime() + 60_000);

    for (let at = 0; at < token.length; at += 1) {
      expect(verifyOwnerToken(flip(token, at), SECRET, now), `character ${at}`).toEqual({
        status: "invalid",
      });
    }
  });

  it("is refused under another secret, cut short, lengthened or not a token at all", () => {
    const token = mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, SECRET, MINTED);
    const now = new Date(MINTED.getTime() + 60_000);

    expect(verifyOwnerToken(token, `${SECRET}-other`, now).status).toBe("invalid");
    expect(verifyOwnerToken(token.slice(0, -1), SECRET, now).status).toBe("invalid");
    expect(verifyOwnerToken(`${token}A`, SECRET, now).status).toBe("invalid");
    expect(verifyOwnerToken("", SECRET, now).status).toBe("invalid");
    expect(verifyOwnerToken("../../etc/passwd", SECRET, now).status).toBe("invalid");
    expect(verifyOwnerToken("é".repeat(92), SECRET, now).status).toBe("invalid");
  });

  it("refuses to mint for an id that is not a UUID, or with a short secret", () => {
    expect(() =>
      mintOwnerToken({ caseId: "not-a-uuid", versionId: VERSION_ID }, SECRET, MINTED),
    ).toThrow(OwnerLinkError);
    expect(() =>
      mintOwnerToken({ caseId: CASE_ID, versionId: VERSION_ID }, "too short", MINTED),
    ).toThrow(OwnerLinkError);
  });
});

describe("the owner's link for a sent estimate", () => {
  const { db } = connectTestDatabase();

  it("is minted for the case's sent version, its path under /e/", async () => {
    const fixture = await makeDentalCase(db, "Link practice");
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });

    const link = await ownerLink(
      db,
      { ...fixture, versionId: draft.id },
      { secret: SECRET, now: MINTED },
    );

    expect(link.path).toBe(`/e/${link.token}`);
    expect(link.expiresAt).toEqual(new Date(MINTED.getTime() + OWNER_LINK_LIFETIME_MS));
    expect(verifyOwnerToken(link.token, SECRET, MINTED)).toMatchObject({
      status: "valid",
      caseId: fixture.caseId,
      versionId: draft.id,
    });
  });

  it("is refused for a draft, another case's version or another practice", async () => {
    const fixture = await makeDentalCase(db, "Link practice");
    const other = await makeDentalCase(db, "Other practice");
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });

    await expect(
      ownerLink(db, { ...fixture, versionId: draft.id }, { secret: SECRET, now: MINTED }),
    ).rejects.toMatchObject({ name: "OwnerLinkError", reason: "version_not_sent" });

    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
    await expect(
      ownerLink(
        db,
        { practiceId: fixture.practiceId, caseId: other.caseId, versionId: draft.id },
        { secret: SECRET, now: MINTED },
      ),
    ).rejects.toMatchObject({ reason: "version_not_found" });
    await expect(
      ownerLink(
        db,
        { practiceId: other.practiceId, caseId: fixture.caseId, versionId: draft.id },
        { secret: SECRET, now: MINTED },
      ),
    ).rejects.toMatchObject({ reason: "version_not_found" });
  });
});
