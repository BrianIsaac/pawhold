import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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

export const practice = pgTable("practice", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: practiceKind("kind").notNull(),
  createdAt: createdAt(),
});

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
    ownerName: text("owner_name").notNull(),
    procedure: text("procedure").notNull(),
    moneyState: moneyState("money_state").notNull().default("estimate_draft"),
    currencyCode: char("currency_code", { length: 3 }).notNull().default("GBP"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("patient_case_currency_code", sql`${table.currencyCode} in ('GBP', 'USD')`),
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
