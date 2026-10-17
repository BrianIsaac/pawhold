import { and, eq } from "drizzle-orm";

import { appendAuditEvent, type AuditEventInput } from "@/audit/writer";
import type { Transaction } from "@/db/client";
import { hold, patientCase, room, vet } from "@/db/schema";
import { currentPriceList, type PriceListWithItems } from "@/estimate/price-list";
import type { EstimateLineInput } from "@/estimate/version";
import type { MoneyState } from "@/money/state";
import type { Species } from "@/practice/species";
import { seededPayPalId } from "@/paypal/seeded";
import { bookSlot } from "@/schedule/bookings";

import { approved, sent, versionMade, writeSentVersion } from "../versions";
import { SHOWCASE_CASE } from "./showcase";

/** The practice's rooms, in the order its day lists them (U8a's brief: two theatres, one consult room). */
export const DAY_ROOMS = [
  { name: "Theatre 1", kind: "theatre" },
  { name: "Theatre 2", kind: "theatre" },
  { name: "Consult room", kind: "consult" },
] as const;

/** The practice's vets: the showcase case's, and one more. Names written for the entry. */
export const DAY_VETS = [SHOWCASE_CASE.vetName, "Imogen Shaw"] as const;

type RoomName = (typeof DAY_ROOMS)[number]["name"];
type VetName = (typeof DAY_VETS)[number];

/** Where a seeded case's booking falls: minutes from the day's anchor, the day's case's start. */
interface DaySlot {
  readonly room: RoomName;
  readonly kind: "procedure" | "consult";
  readonly from: number;
  readonly to: number;
}

/** One case of the seeded day: who, how far its money has gone, its words and its lines, and its slot. */
export interface DayCase {
  readonly patientName: string;
  /** The animal's species (U17), as its notes name it; a consult with none is the seed's choice. */
  readonly species: Species;
  readonly ownerName: string;
  readonly procedure: string;
  readonly vetName: VetName;
  readonly moneyState: Extract<
    MoneyState,
    "estimate_draft" | "awaiting_owner" | "held" | "update_awaiting_owner"
  >;
  readonly notes?: string;
  readonly lines?: readonly EstimateLineInput[];
  readonly finding?: string;
  readonly updateLines?: readonly EstimateLineInput[];
  readonly explanation?: string;
  readonly slot: DaySlot;
}

/**
 * The day's cases (U8a): a theatre list either side of the day's case, Juno,
 * whose update waits on the owner with its procedure due inside the agent's
 * lead time when the session starts; Biscuit's procedure follows it in the
 * same theatre, so the agent has a move to propose. The words and the lines are
 * written for this entry and are what the estimate agent's guardrails let
 * through (a test holds them to it).
 */
export const DAY_CASES: readonly DayCase[] = [
  {
    patientName: "Willow",
    species: "dog",
    ownerName: "Grace Okoro",
    procedure: "Spay",
    vetName: SHOWCASE_CASE.vetName,
    moneyState: "held",
    notes:
      "2yo FE Cockapoo, 11 kg. Routine spay. Plan: pre-op bloods, spay, buster collar, pain relief to go home.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "NEU-DOG-F",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "spay",
        ownerWording: "Spay operation",
      },
      {
        code: "CONS-COLLAR",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "buster collar",
        ownerWording: "A cone collar to protect the wound",
      },
      {
        code: "MED-NSAID-ORAL",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pain relief to go home",
        ownerWording: "Pain relief to take home",
      },
    ],
    slot: { room: "Theatre 1", kind: "procedure", from: -150, to: -60 },
  },
  {
    patientName: "Juno",
    species: "dog",
    ownerName: "Ellis Moran",
    procedure: "Lump removal",
    vetName: SHOWCASE_CASE.vetName,
    moneyState: "update_awaiting_owner",
    notes:
      "8yo FN Labrador, 31 kg. Soft mass on the left flank, needle sample suggests a fatty lump. Plan: pre-op bloods, GA, lump removal, histopathology. Pain relief to go home.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "GA-L",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "GA",
        ownerWording: "General anaesthetic",
      },
      {
        code: "SURG-LUMP",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "lump removal",
        ownerWording: "Removing the lump",
      },
      {
        code: "LAB-HIST",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "histopathology",
        ownerWording: "Laboratory check of the lump",
      },
      {
        code: "MED-NSAID-ORAL",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "Pain relief to go home",
        ownerWording: "Pain relief to take home",
      },
    ],
    finding:
      "Pre-op check found a second lump on the right shoulder. Recommend removing it under the same GA and sending it to the lab as well.",
    updateLines: [
      {
        code: "SURG-LUMP",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "removing it under the same GA",
        ownerWording: "Removing the second lump",
      },
      {
        code: "LAB-HIST",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "sending it to the lab as well",
        ownerWording: "Laboratory check of the second lump",
      },
    ],
    explanation:
      "Rowan found a second lump, on Juno's right shoulder, at the check before the operation. Rowan recommends removing it during the same anaesthetic and sending it to the laboratory as well.",
    slot: { room: "Theatre 1", kind: "procedure", from: 0, to: 60 },
  },
  {
    patientName: "Biscuit",
    species: "dog",
    ownerName: "Hana Kowalski",
    procedure: "Castration",
    vetName: SHOWCASE_CASE.vetName,
    moneyState: "held",
    notes: "1yo ME Beagle, 14 kg. Plan: pre-op bloods, castration, buster collar.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "NEU-DOG-M",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "castration",
        ownerWording: "Castration operation",
      },
      {
        code: "CONS-COLLAR",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "buster collar",
        ownerWording: "A cone collar to protect the wound",
      },
    ],
    slot: { room: "Theatre 1", kind: "procedure", from: 75, to: 135 },
  },
  {
    patientName: "Clover",
    species: "cat",
    ownerName: "Owen Pryce",
    procedure: "Dental under GA",
    vetName: "Imogen Shaw",
    moneyState: "held",
    notes:
      "11yo FN DSH cat, 4.1 kg. Tartar and sore gums. Plan: pre-op bloods, GA, dental charting, dental scale and polish.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "GA-DENT",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "GA",
        ownerWording: "General anaesthetic for the dental work",
      },
      {
        code: "DEN-CHART",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "dental charting",
        ownerWording: "Checking and charting every tooth",
      },
      {
        code: "DEN-SP",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "dental scale and polish",
        ownerWording: "Scale and polish",
      },
    ],
    slot: { room: "Theatre 2", kind: "procedure", from: -120, to: -45 },
  },
  {
    patientName: "Archie",
    species: "dog",
    ownerName: "Freya Lund",
    procedure: "Ear flush under sedation",
    vetName: "Imogen Shaw",
    moneyState: "awaiting_owner",
    notes:
      "6yo MN Cocker Spaniel, 15 kg. Both ears sore and waxy. Plan: ear flush under sedation, ear drops to go home.",
    lines: [
      {
        code: "PROC-EAR",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "ear flush under sedation",
        ownerWording: "Cleaning out both ears under sedation",
      },
      {
        code: "MED-EAR",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "ear drops to go home",
        ownerWording: "Ear drops to take home",
      },
    ],
    slot: { room: "Theatre 2", kind: "procedure", from: 60, to: 105 },
  },
  {
    patientName: "Pip",
    species: "dog",
    ownerName: "Ada Fenwick",
    procedure: "Lame on the left hind leg",
    vetName: "Imogen Shaw",
    moneyState: "estimate_draft",
    slot: { room: "Consult room", kind: "consult", from: -30, to: -15 },
  },
  {
    patientName: "Moss",
    species: "other",
    ownerName: "Theo Grant",
    procedure: "Booster and health check",
    vetName: "Imogen Shaw",
    moneyState: "estimate_draft",
    slot: { room: "Consult room", kind: "consult", from: 15, to: 30 },
  },
];

/** The showcase case's two bookings: its dental on its story's first day, and a check today. */
const SHOWCASE_SLOTS = {
  /** Its dental, in UTC on the day its case was opened: the update was found during it. */
  dental: { room: "Theatre 1", fromHourUtc: 9, toHourUtc: 11.5 },
  /** Its post-operative check on the seeded day, minutes from the anchor. */
  check: { room: "Consult room", kind: "consult", from: -45, to: -30 },
} as const;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;

/**
 * How far ahead of the session's start the day's case is due: inside the
 * practice's default lead time of 30 minutes, so the first check of the day
 * holds its slot (D9 (a)).
 */
export const DAY_CASE_LEAD_MINUTES = 25;

/** What the seeded day made. */
export interface SeededDay {
  readonly roomIds: Readonly<Record<RoomName, string>>;
  readonly vetIds: Readonly<Record<VetName, string>>;
  /** The day's case: its update waits on the owner, its procedure due inside the lead time. */
  readonly dayCaseId: string;
  readonly bookings: number;
}

/**
 * Seeds the practice's day into a new practice, inside the transaction making
 * it, after the showcase case (U8a): its rooms and vets, the day's cases with
 * their seeded stories, and a day of bookings around the session's start, the
 * showcase case's dental among them on the day it happened.
 *
 * @param tx - The transaction making the practice.
 * @param practiceId - The practice.
 * @param day - The showcase case's id and the clock.
 * @param day.showcaseCaseId - The showcase case.
 * @param day.now - The session's start.
 * @returns The rooms, the vets, the day's case and how many bookings were made.
 * @throws Error when the practice has no price list or a line's item is not on it.
 */
export async function seedPracticeDay(
  tx: Transaction,
  practiceId: string,
  day: { showcaseCaseId: string; now?: Date },
): Promise<SeededDay> {
  const now = day.now ?? new Date();
  const list = await currentPriceList(tx, practiceId);
  if (!list) {
    throw new Error("the day's cases are priced from the practice's list: import it first");
  }
  const rooms = await tx
    .insert(room)
    .values(DAY_ROOMS.map((one, at) => ({ practiceId, ...one, position: at + 1 })))
    .returning({ id: room.id, name: room.name });
  const vets = await tx
    .insert(vet)
    .values(DAY_VETS.map((name) => ({ practiceId, name })))
    .returning({ id: vet.id, name: vet.name });
  const roomIds = Object.fromEntries(rooms.map((one) => [one.name, one.id])) as Record<
    RoomName,
    string
  >;
  const vetIds = Object.fromEntries(vets.map((one) => [one.name, one.id])) as Record<
    VetName,
    string
  >;

  const anchor = new Date(
    Math.ceil((now.getTime() + DAY_CASE_LEAD_MINUTES * MINUTE_MS) / FIVE_MINUTES_MS) *
      FIVE_MINUTES_MS,
  );
  const at = (minutes: number): Date => new Date(anchor.getTime() + minutes * MINUTE_MS);
  const storyDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 2 * DAY_MS;

  let bookings = 0;
  let dayCaseId: string | null = null;
  for (const [index, kase] of DAY_CASES.entries()) {
    const caseId = await seedDayCase(tx, {
      practiceId,
      list,
      kase,
      startsAt: new Date(storyDay + 9 * HOUR_MS + index * 20 * MINUTE_MS),
    });
    await bookSlot(tx, {
      practiceId,
      caseId,
      roomId: roomIds[kase.slot.room],
      vetId: vetIds[kase.vetName],
      kind: kase.slot.kind,
      startsAt: at(kase.slot.from),
      endsAt: at(kase.slot.to),
    });
    bookings += 1;
    if (kase.moneyState === "update_awaiting_owner") {
      dayCaseId = caseId;
    }
  }
  if (dayCaseId === null) {
    throw new Error("the seeded day has no case whose update waits on the owner");
  }

  const [showcase] = await tx
    .select({ createdAt: patientCase.createdAt })
    .from(patientCase)
    .where(and(eq(patientCase.id, day.showcaseCaseId), eq(patientCase.practiceId, practiceId)));
  if (!showcase) {
    throw new Error("the showcase case is seeded before the day");
  }
  const showcaseDay = Date.UTC(
    showcase.createdAt.getUTCFullYear(),
    showcase.createdAt.getUTCMonth(),
    showcase.createdAt.getUTCDate(),
  );
  const showcaseVet = vetIds[SHOWCASE_CASE.vetName];
  await bookSlot(tx, {
    practiceId,
    caseId: day.showcaseCaseId,
    roomId: roomIds[SHOWCASE_SLOTS.dental.room],
    vetId: showcaseVet,
    kind: "procedure",
    startsAt: new Date(showcaseDay + SHOWCASE_SLOTS.dental.fromHourUtc * HOUR_MS),
    endsAt: new Date(showcaseDay + SHOWCASE_SLOTS.dental.toHourUtc * HOUR_MS),
  });
  await bookSlot(tx, {
    practiceId,
    caseId: day.showcaseCaseId,
    roomId: roomIds[SHOWCASE_SLOTS.check.room],
    vetId: showcaseVet,
    kind: SHOWCASE_SLOTS.check.kind,
    startsAt: at(SHOWCASE_SLOTS.check.from),
    endsAt: at(SHOWCASE_SLOTS.check.to),
  });
  bookings += 2;
  return { roomIds, vetIds, dayCaseId, bookings };
}

/**
 * Writes one of the day's cases as its stage has it, the way the showcase
 * case is written: rows the database checks as it checks U2's and U3's, every
 * event back-dated to the story and said to be seeded (D16), every PayPal id
 * beginning `SEEDED`, so the hourly rule flags a hold once its honour period
 * is over rather than ever asking PayPal to reauthorise a seeded id.
 *
 * @param tx - The transaction.
 * @param write - The practice, the list, the case and when its story starts.
 * @param write.practiceId - The practice.
 * @param write.list - The price list its lines are priced from.
 * @param write.kase - The case.
 * @param write.startsAt - When it was opened.
 * @returns The case's id.
 */
async function seedDayCase(
  tx: Transaction,
  write: { practiceId: string; list: PriceListWithItems; kase: DayCase; startsAt: Date },
): Promise<string> {
  const { practiceId, list, kase } = write;
  const story = (minutes: number, seconds = 0): Date =>
    new Date(write.startsAt.getTime() + minutes * MINUTE_MS + seconds * 1000);
  const [made] = await tx
    .insert(patientCase)
    .values({
      practiceId,
      patientName: kase.patientName,
      species: kase.species,
      ownerName: kase.ownerName,
      procedure: kase.procedure,
      vetName: kase.vetName,
      moneyState: kase.moneyState,
      currencyCode: list.currencyCode,
      createdAt: story(0),
      updatedAt: story(0),
    })
    .returning({ id: patientCase.id });
  const caseId = made!.id;
  const event = (input: Omit<AuditEventInput, "practiceId" | "caseId">, when: Date) =>
    appendAuditEvent(
      tx,
      { practiceId, caseId, ...input, detail: { ...input.detail, seeded: true } },
      { occurredAt: when },
    );
  await event(
    {
      actor: "vet",
      action: "case.opened",
      moneyStateAfter: "estimate_draft",
      detail: {
        patientName: kase.patientName,
        species: kase.species,
        ownerName: kase.ownerName,
        procedure: kase.procedure,
        vetName: kase.vetName,
      },
    },
    story(0),
  );
  if (kase.moneyState === "estimate_draft") {
    return caseId;
  }
  if (!kase.notes || !kase.lines) {
    throw new Error(`${kase.patientName}'s estimate needs its notes and its lines`);
  }

  const estimate = await writeSentVersion(tx, {
    practiceId,
    caseId,
    list,
    number: 1,
    lines: kase.lines,
    source: { kind: "notes", text: kase.notes, explanation: null },
    madeAt: story(7),
    sentAt: story(14, 30),
  });
  await event(versionMade(estimate), story(7));
  await event(approved(estimate, kase.vetName), story(14));
  await event(sent(estimate, "estimate_draft", "awaiting_owner"), story(14, 30));
  if (kase.moneyState === "awaiting_owner") {
    await settle(tx, caseId, story(14, 30));
    return caseId;
  }

  const ids = { order: seededPayPalId(), authorisation: seededPayPalId() };
  const authorisedAt = story(42);
  const expiresAt = new Date(authorisedAt.getTime() + 29 * DAY_MS);
  await tx.insert(hold).values({
    id: estimate.id,
    practiceId,
    caseId,
    versionNumber: 1,
    versionHighPence: estimate.highPence,
    heldBeforePence: 0,
    amountPence: estimate.highPence,
    currencyCode: estimate.currency,
    status: "authorised",
    paypalOrderId: ids.order,
    authorizationId: ids.authorisation,
    originalAuthorizationId: ids.authorisation,
    paymentKind: "card",
    authorisedAt,
    expiresAt,
    createdAt: story(40),
    updatedAt: authorisedAt,
  });
  const amount = { pence: estimate.highPence, currency: estimate.currency };
  await event(
    {
      actor: "owner",
      action: "hold.ordered",
      amount,
      paypal: { orderId: ids.order },
      detail: { holdId: estimate.id, versionNumber: 1, heldBeforePence: 0 },
    },
    story(40),
  );
  await event(
    {
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "held",
      amount,
      paypal: { orderId: ids.order, authorizationId: ids.authorisation },
      detail: {
        holdId: estimate.id,
        versionNumber: 1,
        paymentKind: "card",
        expiresAt: expiresAt.toISOString(),
      },
    },
    authorisedAt,
  );
  if (kase.moneyState === "held") {
    await settle(tx, caseId, authorisedAt);
    return caseId;
  }
  if (!kase.finding || !kase.updateLines) {
    throw new Error(`${kase.patientName}'s update needs its finding and its lines`);
  }

  const update = await writeSentVersion(tx, {
    practiceId,
    caseId,
    list,
    number: 2,
    lines: [...kase.lines, ...kase.updateLines],
    source: { kind: "finding", text: kase.finding, explanation: kase.explanation ?? null },
    madeAt: story(360),
    sentAt: story(364, 30),
  });
  await event(versionMade(update), story(360));
  await event(approved(update, kase.vetName), story(364));
  await event(sent(update, "held", "update_awaiting_owner"), story(364, 30));
  await settle(tx, caseId, story(364, 30));
  return caseId;
}

/**
 * Sets a seeded case's last change to its story's last event.
 *
 * @param tx - The transaction.
 * @param caseId - The case.
 * @param at - Its story's last event.
 * @returns Resolves once set.
 */
async function settle(tx: Transaction, caseId: string, at: Date): Promise<void> {
  await tx.update(patientCase).set({ updatedAt: at }).where(eq(patientCase.id, caseId));
}
