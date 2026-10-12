import type { EstimateLineInput } from "@/estimate/version";

import type { DAY_VETS } from "../practice/day";

/** A vet of the seeded practice, as its day names them (one practice, one set of vets). */
export type ShowcaseVet = (typeof DAY_VETS)[number];

/** How an owner paid for a seeded hold. */
export type SeededPayment = "paypal" | "card";

/** One line of a seeded bill: the item done and how many times. */
export interface SeededBillLine {
  readonly code: string;
  readonly quantity: number;
}

/**
 * A seeded case's money story, step by step, as plan 3.2 draws it. Each
 * step's time is minutes from the story's start; a step present happened,
 * a step absent did not.
 */
export interface MoneyStory {
  /** The estimate sent to the owner. */
  readonly sentAt: number;
  /** The owner opened PayPal's checkout (`hold.ordered`). */
  readonly orderedAt?: number;
  /** The practice withdrew the estimate before the owner authorised it. */
  readonly withdrawnAt?: number;
  /** The owner authorised the estimate's hold. */
  readonly authorised?: { readonly at: number; readonly payment: SeededPayment };
  /** The hourly rule flagged a card hold past its honour period (minutes after its authorisation). */
  readonly honourPeriodFlaggedAfter?: number;
  /** The vet sent an update and the owner authorised its increase. */
  readonly update?: {
    readonly sentAt: number;
    readonly authorised: { readonly at: number; readonly payment: SeededPayment };
  };
  /** The vet signed off the bill and pawhold captured and released against it. */
  readonly discharge?: { readonly at: number; readonly bill: readonly SeededBillLine[] };
  /** A refund after discharge, from the first hold's capture. */
  readonly refund?: { readonly at: number; readonly pence: number; readonly reason: string };
}

/** A case the showcase adds to the practice's day, for a money state the day does not show. */
export interface MoneyStateCase {
  readonly patientName: string;
  readonly ownerName: string;
  readonly procedure: string;
  readonly vetName: ShowcaseVet;
  /** How many days before the session its story starts, at 07:00 UTC. */
  readonly daysAgo: number;
  readonly notes: string;
  readonly lines: readonly EstimateLineInput[];
  readonly finding?: string;
  readonly updateLines?: readonly EstimateLineInput[];
  readonly explanation?: string;
  readonly story: MoneyStory;
}

const MINUTES_A_DAY = 24 * 60;

/**
 * The case the owner's door opens: an estimate waiting for its owner, with a
 * range and two lines that depend on a finding, over the Order's £500.
 */
export const OWNER_DOOR_CASE: MoneyStateCase = {
  patientName: "Otis",
  ownerName: "Priya Shah",
  procedure: "Ear haematoma repair",
  vetName: "Imogen Shaw",
  daysAgo: 1,
  notes:
    "5yo MN Labrador, 31 kg. Swollen left ear flap, aural haematoma, shaking his head. Plan: pre-op bloods, GA, aural haematoma repair, buster collar, pain relief to go home. Swab the ear canal for cytology if it looks infected, ear drops if so.",
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
      code: "SURG-AURAL",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "aural haematoma repair",
      ownerWording: "Repairing the swollen ear flap",
    },
    {
      code: "CONS-COLLAR",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "buster collar",
      ownerWording: "A cone collar to protect the ear",
    },
    {
      code: "MED-NSAID-ORAL",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "pain relief to go home",
      ownerWording: "Pain relief to take home",
    },
    {
      code: "LAB-CYTO",
      quantityLow: 0,
      quantityHigh: 1,
      dependsOn: "the ear canal looks infected",
      notesSpan: "Swab the ear canal for cytology",
      ownerWording: "A laboratory check of a swab from the ear",
    },
    {
      code: "MED-EAR",
      quantityLow: 0,
      quantityHigh: 1,
      dependsOn: "the ear canal looks infected",
      notesSpan: "ear drops",
      ownerWording: "Ear drops to take home",
    },
  ],
  story: { sentAt: 25 },
};

/**
 * The showcase's own cases (U9): each a money state of plan 3.2 that U5's
 * Bramble and U8a's day do not already show. The words and lines are written
 * for this entry and are what the estimate agent's guardrails let through (a
 * test holds them to it); the figures are the seeded price list's.
 */
export const MONEY_STATE_CASES: readonly MoneyStateCase[] = [
  OWNER_DOOR_CASE,
  {
    patientName: "Hazel",
    ownerName: "Tom Ashworth",
    procedure: "Wound repair",
    vetName: "Rowan Hale",
    daysAgo: 1,
    notes:
      "4yo FN Whippet, 13 kg. Torn skin on the right flank from a fence. Plan: GA, clip and clean, wound repair, antibiotics and pain relief to go home.",
    lines: [
      {
        code: "GA-M",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "GA",
        ownerWording: "General anaesthetic",
      },
      {
        code: "CONS-CLIP",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "clip and clean",
        ownerWording: "Clipping and cleaning the wound",
      },
      {
        code: "SURG-WOUND",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "wound repair",
        ownerWording: "Stitching the torn skin",
      },
      {
        code: "MED-ANTIB-TAB",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "antibiotics",
        ownerWording: "Antibiotic tablets to take home",
      },
      {
        code: "MED-NSAID-ORAL",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pain relief to go home",
        ownerWording: "Pain relief to take home",
      },
    ],
    story: { sentAt: 20, orderedAt: 31, authorised: { at: 33, payment: "paypal" } },
  },
  {
    patientName: "Rufus",
    ownerName: "Carys Evans",
    procedure: "Bladder stone removal",
    vetName: "Rowan Hale",
    daysAgo: 5,
    notes:
      "9yo MN Miniature Schnauzer, 12 kg. Bladder stones on X-ray, straining to pass urine. Plan: pre-op bloods, GA, cystotomy, urine culture, one night in hospital, pain relief to go home.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "GA-M",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "GA",
        ownerWording: "General anaesthetic",
      },
      {
        code: "SURG-CYST",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "cystotomy",
        ownerWording: "An operation to remove the bladder stones",
      },
      {
        code: "LAB-UCULT",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "urine culture",
        ownerWording: "A laboratory check of the urine for infection",
      },
      {
        code: "HOSP-NIGHT",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "one night in hospital",
        ownerWording: "A night in the hospital with nursing checks",
      },
      {
        code: "MED-NSAID-ORAL",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pain relief to go home",
        ownerWording: "Pain relief to take home",
      },
    ],
    story: {
      sentAt: 30,
      orderedAt: 52,
      authorised: { at: 55, payment: "card" },
      honourPeriodFlaggedAfter: 3 * MINUTES_A_DAY + 47,
    },
  },
  {
    patientName: "Poppy",
    ownerName: "Lena Brooks",
    procedure: "Spay",
    vetName: "Imogen Shaw",
    daysAgo: 3,
    notes: "1yo FE DSH cat, 3.2 kg. Routine spay. Plan: spay, body suit, pain relief to go home.",
    lines: [
      {
        code: "NEU-CAT-F",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "spay",
        ownerWording: "Spay operation",
      },
      {
        code: "CONS-SUIT",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "body suit",
        ownerWording: "A body suit to protect the wound",
      },
      {
        code: "MED-NSAID-ORAL",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pain relief to go home",
        ownerWording: "Pain relief to take home",
      },
    ],
    story: {
      sentAt: 15,
      orderedAt: 26,
      authorised: { at: 28, payment: "paypal" },
      discharge: {
        at: 8 * 60,
        bill: [
          { code: "NEU-CAT-F", quantity: 1 },
          { code: "CONS-SUIT", quantity: 1 },
          { code: "MED-NSAID-ORAL", quantity: 1 },
        ],
      },
    },
  },
  {
    patientName: "Teddy",
    ownerName: "Martin Cole",
    procedure: "Vomiting, admitted for tests",
    vetName: "Rowan Hale",
    daysAgo: 3,
    notes:
      "10yo ME Cocker Spaniel, 14 kg. Vomiting for two days, off his food. Plan: blood profile, radiographs, day ward with fluids, anti-sickness injection. May need a second day.",
    lines: [
      {
        code: "LAB-BIO",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "blood profile",
        ownerWording: "Blood tests",
      },
      {
        code: "IMG-XR",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "radiographs",
        ownerWording: "An X-ray of the tummy",
      },
      {
        code: "HOSP-DAY",
        quantityLow: 1,
        quantityHigh: 2,
        dependsOn: "he needs a second day",
        notesSpan: "day ward",
        ownerWording: "A day on the ward",
      },
      {
        code: "HOSP-FLUID",
        quantityLow: 1,
        quantityHigh: 2,
        dependsOn: "he needs a second day",
        notesSpan: "fluids",
        ownerWording: "A drip of fluids",
      },
      {
        code: "MED-ANTIEM",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "anti-sickness injection",
        ownerWording: "An injection to stop the sickness",
      },
    ],
    finding:
      "Radiographs show gas in the stomach and no blockage. Recommend an abdominal ultrasound scan to rule out pancreatitis.",
    updateLines: [
      {
        code: "IMG-US-ABD",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "abdominal ultrasound scan",
        ownerWording: "An ultrasound scan of the tummy",
      },
    ],
    explanation:
      "Rowan found gas in Teddy's stomach on the X-ray, with no blockage. Rowan recommends an ultrasound scan of the tummy to rule out an inflamed pancreas.",
    story: {
      sentAt: 20,
      orderedAt: 34,
      authorised: { at: 36, payment: "paypal" },
      update: { sentAt: 5 * 60, authorised: { at: 5 * 60 + 18, payment: "card" } },
      discharge: {
        at: 9 * 60,
        bill: [
          { code: "LAB-BIO", quantity: 1 },
          { code: "IMG-XR", quantity: 1 },
          { code: "HOSP-DAY", quantity: 1 },
          { code: "HOSP-FLUID", quantity: 1 },
          { code: "MED-ANTIEM", quantity: 1 },
        ],
      },
    },
  },
  {
    patientName: "Luna",
    ownerName: "Sophie Turner",
    procedure: "Spay",
    vetName: "Imogen Shaw",
    daysAgo: 3,
    notes:
      "2yo FE Labrador, 26 kg. Routine spay. Plan: pre-op bloods, spay, buster collar, pain relief to go home.",
    lines: [
      {
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "pre-op bloods",
        ownerWording: "Blood test before the anaesthetic",
      },
      {
        code: "NEU-DOG-F-L",
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
    finding:
      "Found a small lump on the belly while clipping. Recommend removing it under the same GA and sending it to the lab.",
    updateLines: [
      {
        code: "SURG-LUMP",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "removing it under the same GA",
        ownerWording: "Removing the lump",
      },
      {
        code: "LAB-HIST",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "sending it to the lab",
        ownerWording: "A laboratory check of the lump",
      },
    ],
    explanation:
      "Imogen found a small lump on Luna's belly while preparing her for the operation. Imogen recommends removing it during the same anaesthetic and sending it to the laboratory.",
    story: {
      sentAt: 18,
      orderedAt: 29,
      authorised: { at: 31, payment: "paypal" },
      update: { sentAt: 2 * 60 + 10, authorised: { at: 2 * 60 + 24, payment: "card" } },
      discharge: {
        at: 7 * 60,
        bill: [
          { code: "LAB-PRE", quantity: 1 },
          { code: "NEU-DOG-F-L", quantity: 1 },
          { code: "CONS-COLLAR", quantity: 1 },
          { code: "MED-NSAID-ORAL", quantity: 1 },
          { code: "SURG-LUMP", quantity: 1 },
          { code: "LAB-HIST", quantity: 1 },
        ],
      },
      refund: {
        at: MINUTES_A_DAY + 60,
        pence: 2_000,
        reason: "Goodwill: Luna's discharge ran an hour late",
      },
    },
  },
  {
    patientName: "Milo",
    ownerName: "Rhys Morgan",
    procedure: "Castration",
    vetName: "Imogen Shaw",
    daysAgo: 2,
    notes: "6mo ME DSH kitten, 3 kg. Castration.",
    lines: [
      {
        code: "NEU-CAT-M",
        quantityLow: 1,
        quantityHigh: 1,
        notesSpan: "Castration",
        ownerWording: "Castration operation",
      },
    ],
    story: { sentAt: 12, orderedAt: 40, withdrawnAt: 3 * 60 },
  },
];
