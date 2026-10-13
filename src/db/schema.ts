import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { SPECIES } from "../practice/species";

/**
 * A practice is either the seeded showcase, kept for the whole judging
 * period, or one made for a judge's session (plan 7.4).
 */
export const practiceKind = pgEnum("practice_kind", ["showcase", "judge"]);

/** The door a judge came in by on the landing page (plan 7.4). */
export const sessionDoor = pgEnum("session_door", ["practice", "owner"]);

/**
 * A case's money state, as the practice's board colours it (plan 3.2). The
 * per-hold flags (extended, honour period over) belong to the holds (U3).
 */
export const moneyState = pgEnum("money_state", [
  "estimate_draft",
  "awaiting_owner",
  "held",
  "update_awaiting_owner",
  "update_declined",
  "captured",
  "released",
  "refunded",
  "withdrawn",
]);

/**
 * The animal a case is for (U17): a dog, a cat, or another animal, which the
 * owner's page draws as a paw. Made from `SPECIES`, the one list, which the
 * "New case" field, its check and the words for each also read.
 */
export const animalSpecies = pgEnum("animal_species", SPECIES);

/** Who an audit event is about having acted (plan 3.5). */
export const auditActor = pgEnum("audit_actor", [
  "vet",
  "owner",
  "system",
  "schedule_agent",
  "paypal_webhook",
]);

/** How a stored webhook delivery was verified (plan 3.1). */
export const webhookVerification = pgEnum("webhook_verification", ["signature", "postback"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const practice = pgTable(
  "practice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: practiceKind("kind").notNull(),
    createdAt: createdAt(),
    /**
     * The Order's Monetary Threshold as this practice applies it, in pence
     * including VAT: £500 unless the practice sets another (plan 3.3).
     */
    monetaryThresholdPence: integer("monetary_threshold_pence").notNull().default(50_000),
    /**
     * How long before a procedure's start an update still unanswered makes
     * the schedule agent hold its slot (plan 3.4's third job, U8a).
     */
    scheduleLeadMinutes: integer("schedule_lead_minutes").notNull().default(30),
    /** The practice's clock: times are kept in UTC and shown in this zone (U8a). */
    timeZone: text("time_zone").notNull().default("Europe/London"),
  },
  (table) => [
    check("practice_monetary_threshold_positive", sql`${table.monetaryThresholdPence} > 0`),
    check(
      "practice_schedule_lead_minutes_range",
      sql`${table.scheduleLeadMinutes} between 5 and 240`,
    ),
    check("practice_time_zone_length", sql`char_length(${table.timeZone}) between 1 and 64`),
  ],
);

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "restrict" }),
    door: sessionDoor("door").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("session_expires_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
    index("session_practice_id_idx").on(table.practiceId),
    index("session_expires_at_idx").on(table.expiresAt),
  ],
);

export const patientCase = pgTable(
  "patient_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "restrict" }),
    patientName: text("patient_name").notNull(),
    /**
     * The patient's species (U17). No default: every case names one. Migration
     * 0015 gave the cases already open "other", or the seed's species where
     * the seed wrote the case.
     */
    species: animalSpecies("species").notNull(),
    ownerName: text("owner_name").notNull(),
    procedure: text("procedure").notNull(),
    /**
     * The vet the case is under (U5): the name the vet's approval of an
     * estimate is recorded with (plan 3.4) and the owner's page names. Null
     * on cases opened before the practice's screens. One of the practice's
     * vets (U11): `(practice_id, vet_name)` references `vet (practice_id,
     * name)`, checked at commit (migration 0014, custom SQL, as drizzle
     * cannot declare a deferred key).
     */
    vetName: text("vet_name"),
    moneyState: moneyState("money_state").notNull().default("estimate_draft"),
    currencyCode: char("currency_code", { length: 3 }).notNull().default("GBP"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("patient_case_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check(
      "patient_case_vet_name_length",
      sql`${table.vetName} is null or char_length(${table.vetName}) between 1 and 100`,
    ),
    unique("patient_case_id_practice_id_key").on(table.id, table.practiceId),
    index("patient_case_practice_id_idx").on(table.practiceId),
  ],
);

export const webhookEvent = pgTable(
  "webhook_event",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    summary: text("summary"),
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true }),
    transmissionId: text("transmission_id").notNull(),
    transmissionTime: text("transmission_time").notNull(),
    certUrl: text("cert_url"),
    authAlgo: text("auth_algo").notNull(),
    /**
     * The delivery's signature, kept so a stored delivery can be verified
     * again by either method (U0's P8 finding); null on rows stored before
     * migration 0005.
     */
    transmissionSig: text("transmission_sig"),
    verification: webhookVerification("verification").notNull(),
    isMock: boolean("is_mock").notNull().default(false),
    rawBody: text("raw_body").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [index("webhook_event_resource_id_idx").on(table.resourceId)],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    practiceId: uuid("practice_id").references(() => practice.id, { onDelete: "restrict" }),
    caseId: uuid("case_id"),
    actor: auditActor("actor").notNull(),
    action: text("action").notNull(),
    moneyStateBefore: moneyState("money_state_before"),
    moneyStateAfter: moneyState("money_state_after"),
    amountPence: integer("amount_pence"),
    currencyCode: char("currency_code", { length: 3 }),
    paypalOrderId: text("paypal_order_id"),
    paypalAuthorizationId: text("paypal_authorization_id"),
    paypalCaptureId: text("paypal_capture_id"),
    paypalRefundId: text("paypal_refund_id"),
    paypalDebugId: text("paypal_debug_id"),
    webhookEventId: text("webhook_event_id").references(() => webhookEvent.eventId, {
      onDelete: "restrict",
    }),
    webhookVerified: boolean("webhook_verified"),
    modelId: text("model_id"),
    modelInputSha256: text("model_input_sha256"),
    modelOutput: jsonb("model_output"),
    detail: jsonb("detail").notNull().default({}),
  },
  (table) => [
    foreignKey({
      name: "audit_event_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    check("audit_event_action_shape", sql`${table.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*$'`),
    check(
      "audit_event_amount_with_currency",
      sql`(${table.amountPence} is null) = (${table.currencyCode} is null)`,
    ),
    check(
      "audit_event_amount_non_negative",
      sql`${table.amountPence} is null or ${table.amountPence} >= 0`,
    ),
    check(
      "audit_event_currency_code",
      sql`${table.currencyCode} is null or ${table.currencyCode} in ('GBP', 'USD')`,
    ),
    check(
      "audit_event_case_needs_practice",
      sql`${table.caseId} is null or ${table.practiceId} is not null`,
    ),
    check(
      "audit_event_model_step_complete",
      sql`(${table.modelId} is null and ${table.modelInputSha256} is null and ${table.modelOutput} is null)
        or (${table.modelId} is not null and ${table.modelInputSha256} is not null)`,
    ),
    check(
      "audit_event_model_input_sha256",
      sql`${table.modelInputSha256} is null or ${table.modelInputSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index("audit_event_case_id_idx").on(table.caseId, table.id),
    index("audit_event_practice_id_idx").on(table.practiceId, table.id),
  ],
);

/** A price list item's category, as plan 3.3 lists them. */
export const priceCategory = pgEnum("price_category", [
  "consultation",
  "anaesthesia",
  "procedure",
  "imaging",
  "laboratory",
  "medication",
  "hospitalisation",
  "consumable",
]);

/**
 * A practice's price list as imported (plan 3.3). Lists are never changed
 * once imported (migration 0003): a new import makes a new list, and a
 * version keeps the list it was priced from.
 */
export const priceList = pgTable(
  "price_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "restrict" }),
    currencyCode: char("currency_code", { length: 3 }).notNull().default("GBP"),
    sourceName: text("source_name").notNull(),
    /** How many items the list was imported with; the database holds it to that (migration 0003). */
    itemCount: integer("item_count").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("price_list_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check("price_list_item_count_range", sql`${table.itemCount} between 1 and 2000`),
    unique("price_list_id_practice_id_key").on(table.id, table.practiceId),
    index("price_list_practice_id_idx").on(table.practiceId, table.importedAt),
  ],
);

/** One item of a price list: a unit price in pence including VAT (plan 3.3). */
export const priceListItem = pgTable(
  "price_list_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceList.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: priceCategory("category").notNull(),
    unit: text("unit").notNull(),
    unitPricePence: integer("unit_price_pence").notNull(),
  },
  (table) => [
    check("price_list_item_unit_price_non_negative", sql`${table.unitPricePence} >= 0`),
    unique("price_list_item_code_key").on(table.priceListId, table.code),
    unique("price_list_item_priced_key").on(table.id, table.priceListId, table.unitPricePence),
  ],
);

/**
 * A numbered version of a case's estimate (plan 3.3). A draft until sent;
 * sent, it never changes (migration 0003), and a change is a new version.
 * The totals are set when it is sent, and the database checks them against
 * its lines.
 */
export const estimateVersion = pgTable(
  "estimate_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    priceListId: uuid("price_list_id").notNull(),
    number: integer("number").notNull(),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    totalLowPence: integer("total_low_pence"),
    totalHighPence: integer("total_high_pence"),
  },
  (table) => [
    foreignKey({
      name: "estimate_version_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimate_version_price_list_in_practice_fk",
      columns: [table.priceListId, table.practiceId],
      foreignColumns: [priceList.id, priceList.practiceId],
    }).onDelete("restrict"),
    check("estimate_version_number_positive", sql`${table.number} >= 1`),
    check(
      "estimate_version_totals_when_sent",
      sql`(${table.sentAt} is null and ${table.totalLowPence} is null and ${table.totalHighPence} is null)
        or (${table.sentAt} is not null and ${table.totalLowPence} is not null and ${table.totalHighPence} is not null)`,
    ),
    check(
      "estimate_version_totals_range",
      sql`${table.totalLowPence} is null or (${table.totalLowPence} >= 0 and ${table.totalHighPence} >= ${table.totalLowPence})`,
    ),
    unique("estimate_version_case_number_key").on(table.caseId, table.number),
    unique("estimate_version_id_price_list_id_key").on(table.id, table.priceListId),
    /** What the words a version was drafted from name of it (U5): its case and practice. */
    unique("estimate_version_id_case_practice_key").on(table.id, table.caseId, table.practiceId),
    /** What a hold names of its version (U3): the case, the number and the top of the range. */
    unique("estimate_version_hold_key").on(
      table.id,
      table.caseId,
      table.number,
      table.totalHighPence,
    ),
    uniqueIndex("estimate_version_one_draft_per_case_idx")
      .on(table.caseId)
      .where(sql`${table.sentAt} is null`),
  ],
);

/**
 * One line of an estimate version (plan 3.3). Its unit price is the list's
 * (a foreign key to the item at that price), and its money is worked out by
 * the database from the price and the quantity range.
 */
export const estimateLine = pgTable(
  "estimate_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull(),
    priceListId: uuid("price_list_id").notNull(),
    position: integer("position").notNull(),
    priceListItemId: uuid("price_list_item_id").notNull(),
    unitPricePence: integer("unit_price_pence").notNull(),
    quantityLow: integer("quantity_low").notNull(),
    quantityHigh: integer("quantity_high").notNull(),
    lowPence: integer("low_pence")
      .notNull()
      .generatedAlwaysAs(sql`unit_price_pence * quantity_low`),
    highPence: integer("high_pence")
      .notNull()
      .generatedAlwaysAs(sql`unit_price_pence * quantity_high`),
    dependsOn: text("depends_on"),
    notesSpan: text("notes_span"),
    ownerWording: text("owner_wording"),
  },
  (table) => [
    foreignKey({
      name: "estimate_line_version_fk",
      columns: [table.versionId, table.priceListId],
      foreignColumns: [estimateVersion.id, estimateVersion.priceListId],
    }).onDelete("cascade"),
    foreignKey({
      name: "estimate_line_priced_from_list_fk",
      columns: [table.priceListItemId, table.priceListId, table.unitPricePence],
      foreignColumns: [priceListItem.id, priceListItem.priceListId, priceListItem.unitPricePence],
    }).onDelete("restrict"),
    check("estimate_line_position_positive", sql`${table.position} >= 1`),
    check(
      "estimate_line_quantity_range",
      sql`${table.quantityLow} >= 0 and ${table.quantityHigh} >= ${table.quantityLow} and ${table.quantityHigh} >= 1`,
    ),
    unique("estimate_line_position_key").on(table.versionId, table.position),
    /** What a bill line names of the estimate line it fulfils (U3): its unit price. */
    unique("estimate_line_priced_key").on(table.id, table.unitPricePence),
    index("estimate_line_item_idx").on(table.priceListItemId),
  ],
);

/**
 * The estimate agent's answers kept by practice and request hash (D8's draft
 * cache): the same notes and list drafted twice in a practice ask the model
 * once. Only answers that passed the job's envelope are kept. A practice's
 * own, so one judge's cache never answers, or reveals, another's notes.
 */
export const agentAnswer = pgTable(
  "agent_answer",
  {
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "cascade" }),
    inputSha256: text("input_sha256").notNull(),
    job: text("job").notNull(),
    modelId: text("model_id").notNull(),
    servedModel: text("served_model").notNull(),
    answer: jsonb("answer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "agent_answer_pkey", columns: [table.practiceId, table.inputSha256] }),
    check("agent_answer_input_sha256", sql`${table.inputSha256} ~ '^[0-9a-f]{64}$'`),
    check("agent_answer_job", sql`${table.job} in ('draft', 'update')`),
  ],
);

/**
 * Where a hold stands (plan 3.2, U3). `ordered`: the PayPal order exists and
 * waits for the owner; `authorised`: the money is held; `captured`: closed by
 * a final capture (any rest released by PayPal with no void); `voided`:
 * closed by a void, after any non-final captures; `expired`: PayPal says the
 * authorisation can no longer be captured; `withdrawn` and `declined`: the
 * order was never authorised (the estimate withdrawn, the update declined),
 * so nothing was held and nothing is voided.
 */
export const holdStatus = pgEnum("hold_status", [
  "ordered",
  "authorised",
  "captured",
  "voided",
  "expired",
  "withdrawn",
  "declined",
]);

/** How the owner paid for a hold, from the authorised order's payment source. */
export const paymentKind = pgEnum("payment_kind", ["paypal", "card"]);

/** A capture's status, as PayPal's `capture_status` enum names it, lower-cased. */
export const captureStatus = pgEnum("capture_status", [
  "completed",
  "pending",
  "declined",
  "partially_refunded",
  "refunded",
  "failed",
]);

/**
 * A refund's status: `requested` until PayPal has answered, then PayPal's
 * `refund_status` lower-cased.
 */
export const refundStatus = pgEnum("refund_status", [
  "requested",
  "pending",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * One hold: a PayPal order authorised for one approved estimate version (plan
 * 3.2). Its id is its version's, so the `PayPal-Request-Id` of every step
 * against it can be derived before the row exists. It holds the top of the
 * version's range less what the case already holds (D3): the first hold is
 * the estimate's top, an update's hold the increase, and together a case's
 * authorised holds are the top of its latest approved version.
 */
export const hold = pgTable(
  "hold",
  {
    id: uuid("id").primaryKey(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    versionHighPence: integer("version_high_pence").notNull(),
    heldBeforePence: integer("held_before_pence").notNull(),
    amountPence: integer("amount_pence").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    status: holdStatus("status").notNull().default("ordered"),
    paypalOrderId: text("paypal_order_id").notNull(),
    /** The authorisation captures and voids go against: the reauthorised one after a reauthorisation. */
    authorizationId: text("authorization_id"),
    /** The order's own authorisation; the honour period and the 29 days count from it. */
    originalAuthorizationId: text("original_authorization_id"),
    paymentKind: paymentKind("payment_kind"),
    /** PayPal's `create_time` of the original authorisation. */
    authorisedAt: timestamp("authorised_at", { withTimezone: true }),
    /** PayPal's `expiration_time` of the authorisation captures go against. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reauthorisedAt: timestamp("reauthorised_at", { withTimezone: true }),
    /** When PayPal refused this wallet hold's reauthorisation for good. */
    reauthoriseRefusedAt: timestamp("reauthorise_refused_at", { withTimezone: true }),
    /** When the practice was told the hold is past its honour period. */
    honourPeriodFlaggedAt: timestamp("honour_period_flagged_at", { withTimezone: true }),
    /** When PayPal's `PAYMENT.AUTHORIZATION.CREATED` was reconciled against it. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "hold_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "hold_version_fk",
      columns: [table.id, table.caseId, table.versionNumber, table.versionHighPence],
      foreignColumns: [
        estimateVersion.id,
        estimateVersion.caseId,
        estimateVersion.number,
        estimateVersion.totalHighPence,
      ],
    }).onDelete("restrict"),
    unique("hold_paypal_order_id_key").on(table.paypalOrderId),
    unique("hold_authorization_id_key").on(table.authorizationId),
    unique("hold_original_authorization_id_key").on(table.originalAuthorizationId),
    check("hold_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check("hold_held_before_non_negative", sql`${table.heldBeforePence} >= 0`),
    check(
      "hold_amount_is_increase",
      sql`${table.amountPence} > 0 and ${table.amountPence} = ${table.versionHighPence} - ${table.heldBeforePence}`,
    ),
    check(
      "hold_authorisation_with_status",
      sql`(${table.status} in ('ordered', 'withdrawn', 'declined')) = (${table.authorizationId} is null)`,
    ),
    check(
      "hold_authorisation_complete",
      sql`(${table.authorizationId} is null) = (${table.originalAuthorizationId} is null)
        and (${table.authorizationId} is null) = (${table.paymentKind} is null)
        and (${table.authorizationId} is null) = (${table.authorisedAt} is null)`,
    ),
    check(
      "hold_reauthorised_wallet_only",
      sql`${table.reauthorisedAt} is null
        or (${table.paymentKind} = 'paypal' and ${table.authorizationId} <> ${table.originalAuthorizationId})`,
    ),
    check(
      "hold_closed_with_status",
      sql`(${table.status} in ('ordered', 'authorised')) = (${table.closedAt} is null)`,
    ),
    index("hold_case_id_idx").on(table.caseId, table.versionNumber),
  ],
);

/**
 * One capture against a hold (plan 3.2). D17: captures are made at discharge,
 * the last against each hold final. The database refuses captures that sum
 * above their hold (migration 0006).
 */
export const capture = pgTable(
  "capture",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holdId: uuid("hold_id")
      .notNull()
      .references(() => hold.id, { onDelete: "restrict" }),
    /** The capture's ordinal against its hold, in its `PayPal-Request-Id` step (`capture.1`). */
    sequence: integer("sequence").notNull(),
    paypalCaptureId: text("paypal_capture_id").notNull(),
    /** The authorisation it was captured against. */
    authorizationId: text("authorization_id").notNull(),
    amountPence: integer("amount_pence").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    finalCapture: boolean("final_capture").notNull(),
    status: captureStatus("status").notNull(),
    paypalFeePence: integer("paypal_fee_pence"),
    netPence: integer("net_pence"),
    /** PayPal's `create_time` of the capture. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** When PayPal's `PAYMENT.CAPTURE.COMPLETED` was reconciled against it. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("capture_paypal_capture_id_key").on(table.paypalCaptureId),
    unique("capture_sequence_key").on(table.holdId, table.sequence),
    check("capture_sequence_positive", sql`${table.sequence} >= 1`),
    check("capture_amount_positive", sql`${table.amountPence} > 0`),
    check("capture_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check(
      "capture_fee_non_negative",
      sql`${table.paypalFeePence} is null or ${table.paypalFeePence} >= 0`,
    ),
  ],
);

/**
 * One refund of a capture, part or whole (plan 3.2: "goodwill or
 * correction"). The row is written before PayPal is asked, so a retry sends
 * the same amount under the same `PayPal-Request-Id`; the database refuses
 * refunds that sum above their capture (migration 0006).
 */
export const refund = pgTable(
  "refund",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => capture.id, { onDelete: "restrict" }),
    /** The refund's ordinal against its capture, in its `PayPal-Request-Id` step. */
    sequence: integer("sequence").notNull(),
    amountPence: integer("amount_pence").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    reason: text("reason").notNull(),
    requestedBy: auditActor("requested_by").notNull(),
    status: refundStatus("status").notNull().default("requested"),
    paypalRefundId: text("paypal_refund_id"),
    /** PayPal's `create_time` of the refund. */
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    /** When PayPal's `PAYMENT.CAPTURE.REFUNDED` was reconciled against it. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("refund_paypal_refund_id_key").on(table.paypalRefundId),
    unique("refund_sequence_key").on(table.captureId, table.sequence),
    check("refund_sequence_positive", sql`${table.sequence} >= 1`),
    check("refund_amount_positive", sql`${table.amountPence} > 0`),
    check("refund_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check("refund_reason_length", sql`char_length(${table.reason}) between 1 and 500`),
    check(
      "refund_answered_with_id",
      sql`(${table.status} <> 'requested' or ${table.paypalRefundId} is null)
        and (${table.status} not in ('pending', 'completed') or ${table.paypalRefundId} is not null)`,
    ),
  ],
);

/**
 * The itemised bill a vet signs off at discharge (plan 3.3): each line
 * fulfils a line of the case's latest approved estimate, priced as that line
 * is. Signed off, it never changes (migration 0006).
 */
export const bill = pgTable(
  "bill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    totalPence: integer("total_pence").notNull(),
    signedOffBy: auditActor("signed_off_by").notNull(),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      name: "bill_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    unique("bill_case_id_key").on(table.caseId),
    check("bill_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
    check("bill_total_non_negative", sql`${table.totalPence} >= 0`),
  ],
);

/** One line of a bill: the estimate line it fulfils and the quantity done. */
export const billLine = pgTable(
  "bill_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bill.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    estimateLineId: uuid("estimate_line_id").notNull(),
    quantity: integer("quantity").notNull(),
    unitPricePence: integer("unit_price_pence").notNull(),
    amountPence: integer("amount_pence")
      .notNull()
      .generatedAlwaysAs(sql`unit_price_pence * quantity`),
  },
  (table) => [
    foreignKey({
      name: "bill_line_priced_from_estimate_fk",
      columns: [table.estimateLineId, table.unitPricePence],
      foreignColumns: [estimateLine.id, estimateLine.unitPricePence],
    }).onDelete("restrict"),
    unique("bill_line_position_key").on(table.billId, table.position),
    unique("bill_line_estimate_line_key").on(table.billId, table.estimateLineId),
    check("bill_line_position_positive", sql`${table.position} >= 1`),
    check("bill_line_quantity_positive", sql`${table.quantity} >= 1`),
  ],
);

/**
 * The part of a bill line one hold pays (plan 3.2, rule 2). A line's
 * allocations sum to the line, and a hold's to at most the hold (migration
 * 0006).
 */
export const allocation = pgTable(
  "allocation",
  {
    billLineId: uuid("bill_line_id")
      .notNull()
      .references(() => billLine.id, { onDelete: "restrict" }),
    holdId: uuid("hold_id")
      .notNull()
      .references(() => hold.id, { onDelete: "restrict" }),
    amountPence: integer("amount_pence").notNull(),
  },
  (table) => [
    primaryKey({ name: "allocation_pkey", columns: [table.billLineId, table.holdId] }),
    check("allocation_amount_positive", sql`${table.amountPence} > 0`),
    index("allocation_hold_id_idx").on(table.holdId),
  ],
);

/** What a version was drafted from: the vet's notes, or an update's finding (U5). */
export const estimateSourceKind = pgEnum("estimate_source_kind", ["notes", "finding"]);

/** The image types an update's photo may be (U4's `draftUpdate`). */
export const PHOTO_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * The vet's own words a version was drafted from, and what the draft made of
 * them (U5; U4's finding 7: "nothing holds the vet's notes, the vet's
 * finding, the update's photo or the owner's explanation beside a
 * version"). The notes for a first estimate; for an update, the vet's
 * finding, its optional photo and whether the owner may see it, and the
 * owner's explanation when it passed its checks. Written while the version
 * is a draft, replaced by each redraft, and never changed once the version
 * is sent (migration 0010).
 */
export const estimateSource = pgTable(
  "estimate_source",
  {
    versionId: uuid("version_id").primaryKey(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    kind: estimateSourceKind("kind").notNull(),
    /** The notes or the finding, as the vet wrote them. */
    text: text("text").notNull(),
    /** Spans no price list item matched (U4's `UnmatchedSpan[]`). */
    unmatched: jsonb("unmatched").notNull().default([]),
    /** Lines the draft left out (U4's `UnsupportedLine[]`). */
    unsupported: jsonb("unsupported").notNull().default([]),
    /** Why the model gave nothing usable (U4's `AskFailure`), or null. */
    failure: jsonb("failure"),
    /** The owner's explanation of an update, shown only when it passed its checks. */
    explanation: text("explanation"),
    /** Why the model's explanation was withheld, or null. */
    explanationFellBack: text("explanation_fell_back"),
    photo: bytea("photo"),
    photoMediaType: text("photo_media_type"),
    photoSha256: text("photo_sha256"),
    /** "Show the photo to the owner" (section 6). */
    photoShared: boolean("photo_shared").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "estimate_source_version_fk",
      columns: [table.versionId, table.caseId, table.practiceId],
      foreignColumns: [estimateVersion.id, estimateVersion.caseId, estimateVersion.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "estimate_source_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    check("estimate_source_text_length", sql`char_length(${table.text}) between 1 and 10000`),
    check(
      "estimate_source_photo_complete",
      sql`(${table.photo} is null) = (${table.photoMediaType} is null)
        and (${table.photo} is null) = (${table.photoSha256} is null)`,
    ),
    check(
      "estimate_source_photo_on_finding",
      sql`${table.photo} is null or ${table.kind} = 'finding'`,
    ),
    check(
      "estimate_source_photo_shared_with_photo",
      sql`not ${table.photoShared} or ${table.photo} is not null`,
    ),
    check(
      "estimate_source_photo_media_type",
      sql`${table.photoMediaType} is null or ${table.photoMediaType} in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
    check(
      "estimate_source_photo_size",
      sql`${table.photo} is null or octet_length(${table.photo}) between 1 and 5242880`,
    ),
    check(
      "estimate_source_photo_sha256",
      sql`${table.photoSha256} is null or ${table.photoSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "estimate_source_explanation_on_finding",
      sql`(${table.explanation} is null and ${table.explanationFellBack} is null) or ${table.kind} = 'finding'`,
    ),
    index("estimate_source_case_id_idx").on(table.caseId),
  ],
);

/** A room the practice books: a theatre or a consult room (U8a). */
export const roomKind = pgEnum("room_kind", ["theatre", "consult"]);

/** What a booking is for: a procedure or a consultation (U8a). */
export const bookingKind = pgEnum("booking_kind", ["procedure", "consult"]);

/** One of the practice's rooms, in the order its day lists them (U8a). */
export const room = pgTable(
  "room",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: roomKind("kind").notNull(),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("room_name_length", sql`char_length(${table.name}) between 1 and 60`),
    check("room_position_positive", sql`${table.position} >= 1`),
    unique("room_practice_name_key").on(table.practiceId, table.name),
    unique("room_practice_position_key").on(table.practiceId, table.position),
    unique("room_id_practice_id_key").on(table.id, table.practiceId),
  ],
);

/** One of the practice's vets, as the day books them (U8a). */
export const vet = pgTable(
  "vet",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practice.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("vet_name_length", sql`char_length(${table.name}) between 1 and 100`),
    unique("vet_practice_name_key").on(table.practiceId, table.name),
    unique("vet_id_practice_id_key").on(table.id, table.practiceId),
  ],
);

/**
 * A case booked into a room with a vet, from a start to an end, on the
 * five-minute marks (U8a). Times are kept in UTC. A room and a vet are never
 * booked twice at once: the database refuses it at commit (migration 0012),
 * so two bookings may change places inside one transaction.
 */
export const booking = pgTable(
  "booking",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    roomId: uuid("room_id").notNull(),
    vetId: uuid("vet_id").notNull(),
    kind: bookingKind("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "booking_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "booking_room_in_practice_fk",
      columns: [table.roomId, table.practiceId],
      foreignColumns: [room.id, room.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "booking_vet_in_practice_fk",
      columns: [table.vetId, table.practiceId],
      foreignColumns: [vet.id, vet.practiceId],
    }).onDelete("restrict"),
    check(
      "booking_length",
      sql`${table.endsAt} - ${table.startsAt} between interval '15 minutes' and interval '12 hours'`,
    ),
    check(
      "booking_on_five_minute_marks",
      sql`extract(epoch from ${table.startsAt}) % 300 = 0 and extract(epoch from ${table.endsAt}) % 300 = 0`,
    ),
    unique("booking_id_practice_id_key").on(table.id, table.practiceId),
    /** What the schedule agent's proposal names of the booking it holds: its case too. */
    unique("booking_id_case_practice_key").on(table.id, table.caseId, table.practiceId),
    index("booking_practice_starts_at_idx").on(table.practiceId, table.startsAt),
    index("booking_case_id_idx").on(table.caseId),
  ],
);

/**
 * Where the schedule agent's proposed move stands (D9 (a): a move waits for
 * the practice's click): `proposed` until the practice moves it or dismisses
 * it, or the agent withdraws it (the update answered, the hold undone, or the
 * slot started).
 */
export const scheduleMoveStatus = pgEnum("schedule_move_status", [
  "proposed",
  "applied",
  "dismissed",
  "withdrawn",
]);

/** Who released a held slot: the practice by its one click, or the agent once the update was answered. */
export const scheduleReleasedBy = pgEnum("schedule_released_by", ["practice", "agent"]);

/**
 * One act of the schedule agent (plan 3.4's third job, D9 (a)): a procedure's
 * slot held at once because its case's update waits on the owner inside the
 * practice's lead time, and the move of the room's next procedure into it
 * proposed beside it. Open while the hold stands; once per booking and update,
 * so a hold the practice undid is not held again for the same update. Every
 * change is an audit event in the same transaction.
 */
export const scheduleProposal = pgTable(
  "schedule_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id").notNull(),
    caseId: uuid("case_id").notNull(),
    bookingId: uuid("booking_id").notNull(),
    /** The update waiting on the owner when the slot was held. */
    versionId: uuid("version_id").notNull(),
    /** Why, in section 6's words, as the agent wrote it when it held the slot. */
    reason: text("reason").notNull(),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: scheduleReleasedBy("released_by"),
    /** The room's next procedure, proposed to move into the held slot. */
    moveBookingId: uuid("move_booking_id"),
    /** Where the move puts it: the held slot's start when the move was proposed. */
    moveTo: timestamp("move_to", { withTimezone: true }),
    moveStatus: scheduleMoveStatus("move_status"),
    moveDecidedAt: timestamp("move_decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "schedule_proposal_booking_fk",
      columns: [table.bookingId, table.caseId, table.practiceId],
      foreignColumns: [booking.id, booking.caseId, booking.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "schedule_proposal_case_in_practice_fk",
      columns: [table.caseId, table.practiceId],
      foreignColumns: [patientCase.id, patientCase.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "schedule_proposal_version_fk",
      columns: [table.versionId, table.caseId, table.practiceId],
      foreignColumns: [estimateVersion.id, estimateVersion.caseId, estimateVersion.practiceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "schedule_proposal_move_booking_fk",
      columns: [table.moveBookingId, table.practiceId],
      foreignColumns: [booking.id, booking.practiceId],
    }).onDelete("restrict"),
    check("schedule_proposal_reason_length", sql`char_length(${table.reason}) between 1 and 500`),
    check(
      "schedule_proposal_released_complete",
      sql`(${table.releasedAt} is null) = (${table.releasedBy} is null)`,
    ),
    check(
      "schedule_proposal_move_complete",
      sql`(${table.moveBookingId} is null) = (${table.moveStatus} is null)
        and (${table.moveBookingId} is null) = (${table.moveTo} is null)`,
    ),
    check(
      "schedule_proposal_move_decided",
      sql`(${table.moveDecidedAt} is not null) = (${table.moveStatus} is not null and ${table.moveStatus} <> 'proposed')`,
    ),
    check(
      "schedule_proposal_move_another_booking",
      sql`${table.moveBookingId} is null or ${table.moveBookingId} <> ${table.bookingId}`,
    ),
    unique("schedule_proposal_booking_version_key").on(table.bookingId, table.versionId),
    uniqueIndex("schedule_proposal_one_open_per_booking_idx")
      .on(table.bookingId)
      .where(sql`${table.releasedAt} is null`),
    index("schedule_proposal_practice_idx").on(table.practiceId, table.heldAt),
    index("schedule_proposal_case_idx").on(table.caseId),
  ],
);
