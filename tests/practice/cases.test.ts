import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditEvent, patientCase, practice, vet } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { makeEstimateVersion } from "@/estimate/version";
import { firstName } from "@/practice/chips";
import { openCase, type OpenCaseRequest, todaysCases } from "@/practice/cases";
import { PracticeError } from "@/practice/errors";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, DENTAL_PRICES } from "../support/money";

const { db } = connectTestDatabase();

let practiceId: string;

beforeAll(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Cases practice", kind: "judge" })
    .returning();
  practiceId = made!.id;
  await importPriceList(db, {
    practiceId,
    actor: "system",
    sourceName: "prices.csv",
    csv: DENTAL_PRICES,
  });
});

const CASE = {
  patientName: "Pepper",
  ownerName: "Ann Owner",
  procedure: "Dental under GA",
  vetName: "Rowan Hale",
  species: "dog",
} as const;

describe("opening a case", () => {
  it("opens it under its vet, in draft, and writes case.opened by the vet", async () => {
    const caseId = await openCase(db, { practiceId, ...CASE });

    const [kase] = await db.select().from(patientCase).where(eq(patientCase.id, caseId));
    expect(kase).toMatchObject({ ...CASE, practiceId, moneyState: "estimate_draft" });
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "case.opened")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "vet",
      moneyStateAfter: "estimate_draft",
      detail: CASE,
    });
  });

  it("ties the case to the practice's vet of that name, adding the vet when the practice has none (U11)", async () => {
    await openCase(db, { practiceId, ...CASE, vetName: "Asha Verma" });
    await openCase(db, { practiceId, ...CASE, vetName: "Asha Verma" });

    const vets = await db
      .select({ name: vet.name })
      .from(vet)
      .where(and(eq(vet.practiceId, practiceId), eq(vet.name, "Asha Verma")));
    expect(vets).toEqual([{ name: "Asha Verma" }]);
  });

  it("refuses a case naming a vet the practice does not have (U11)", async () => {
    const refused = await db
      .insert(patientCase)
      .values({ practiceId, ...CASE, vetName: "Nobody At All" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((refused as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      "patient_case_vet_fk",
    );
  });

  it("trims what was typed", async () => {
    const caseId = await openCase(db, { practiceId, ...CASE, patientName: "  Pepper  " });
    const [kase] = await db.select().from(patientCase).where(eq(patientCase.id, caseId));
    expect(kase?.patientName).toBe("Pepper");
  });

  it("refuses a blank field, naming it", async () => {
    const refused = await openCase(db, { practiceId, ...CASE, ownerName: "   " }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PracticeError);
    expect((refused as PracticeError).reason).toBe("request_invalid");
    expect((refused as PracticeError).fields).toHaveProperty("ownerName");
  });

  it("refuses a case without its species, naming the field (U17)", async () => {
    const withoutSpecies = {
      practiceId,
      patientName: CASE.patientName,
      ownerName: CASE.ownerName,
      procedure: CASE.procedure,
      vetName: CASE.vetName,
    };
    const refused = await openCase(db, withoutSpecies as unknown as OpenCaseRequest).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PracticeError);
    expect((refused as PracticeError).fields).toEqual({ species: "Choose the species" });
  });

  it.each(["", "hamster", "Dog"])(
    "refuses %j as a species, naming the field (U17)",
    async (species) => {
      const refused = await openCase(db, { practiceId, ...CASE, species }).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PracticeError);
      expect((refused as PracticeError).fields).toEqual({ species: "Choose the species" });
    },
  );

  it("refuses a name past 100 characters", async () => {
    await expect(
      openCase(db, { practiceId, ...CASE, vetName: "x".repeat(101) }),
    ).rejects.toBeInstanceOf(PracticeError);
  });
});

describe("today's cases", () => {
  it("lists the practice's cases, the latest changed first, each with its chips and next step", async () => {
    const [other] = await db
      .insert(practice)
      .values({ name: "Another", kind: "judge" })
      .returning();
    await importPriceList(db, {
      practiceId: other!.id,
      actor: "system",
      sourceName: "prices.csv",
      csv: DENTAL_PRICES,
    });
    const first = await openCase(db, { practiceId: other!.id, ...CASE, patientName: "Older" });
    const second = await openCase(db, {
      practiceId: other!.id,
      ...CASE,
      patientName: "Newer",
      species: "cat",
    });
    await makeEstimateVersion(db, {
      practiceId: other!.id,
      caseId: second,
      actor: "vet",
      lines: DENTAL_LINES,
    });

    const listed = await todaysCases(db, other!.id);

    expect(listed.map((one) => one.id)).toEqual([second, first]);
    expect(listed[0]).toMatchObject({
      patientName: "Newer",
      species: "cat",
      ownerName: "Ann Owner",
      procedure: "Dental under GA",
      chips: [{ tone: "estimate_draft", label: "Estimate draft" }],
      next: "Review and send the estimate",
    });
    expect(listed[1]?.next).toBe("Draft the estimate");
    expect(listed[1]?.species).toBe("dog");
  });

  it("never lists another practice's case", async () => {
    const [lonely] = await db
      .insert(practice)
      .values({ name: "Lonely", kind: "judge" })
      .returning();
    expect(await todaysCases(db, lonely!.id)).toEqual([]);
  });
});

describe("an owner's first name", () => {
  it("is the first word of the name held", () => {
    expect(firstName("Nadia Haddad")).toBe("Nadia");
    expect(firstName("  Cher ")).toBe("Cher");
  });
});
