import type { PayPalError } from "@/paypal/client";

import { captureAuthorization, getAuthorization, pence, reauthorizeAuthorization } from "./paypal";
import {
  attempt,
  gbp,
  issues,
  makeWalletHold,
  type Observation,
  type Probe,
  type ProbeContext,
} from "./probe";

/** The plan's date for P5 (b) and (c): day 5 of holds made on 12 and 13 October. */
export const P5_LATER_DATE = "2026-10-17";

const HONOUR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

const NEGATIVE_TEST = JSON.stringify({ mock_application_codes: "AUTHORIZATION_EXPIRED" });

const BRANCH_A =
  "Reauthorisation was accepted inside the honour period: recorded; the job's rule (reauthorise a PayPal-account hold once per honour period, from day 4) is unchanged.";
const BRANCH_B =
  "Reauthorisation refused on day 4 or later: the job is kept but turned off in judge mode, and long stays are flagged to the practice instead.";
const BRANCH_C = "A card hold reauthorised: the job extends card holds too.";

/**
 * When an authorisation's honour period ends: three days from its creation.
 *
 * @param createTime - PayPal's `create_time`.
 * @returns The instant, ISO 8601 in UTC, or null when the time is unread.
 */
export function honourPeriodEnds(createTime: string | undefined): string | null {
  const at = createTime ? Date.parse(createTime) : Number.NaN;
  return Number.isNaN(at) ? null : new Date(at + HONOUR_PERIOD_MS).toISOString();
}

/**
 * P5 (a). A fresh wallet hold cannot be reauthorised inside its honour
 * period; the hold is left standing for P5 (b). Then negative testing: a
 * capture with `PayPal-Mock-Response` asking for `AUTHORIZATION_EXPIRED`,
 * on a second, small hold, the sandbox clock not running out.
 */
export const p5a: Probe = {
  id: "P5A",
  title:
    "Reauthorisation inside the honour period, and an expired authorisation by negative testing",
  question:
    'Reauthorising a fresh £100.00 wallet hold is refused (the reference names `REAUTHORIZATION_TOO_SOON`, the guide\'s sample `REAUTHORIZE_NOT_ALLOWED`; the name PayPal returns is recorded). Pass if refused. The hold is left standing for P5 (b). Then a capture of a £1.00 hold sent with `PayPal-Mock-Response: {"mock_application_codes": "AUTHORIZATION_EXPIRED"}`, recorded as answered.',
  async run(context) {
    const kept = await makeWalletHold(context, "kept", gbp(10_000));
    const ends = honourPeriodEnds(kept.authorization.create_time);
    const observations: Record<string, Observation> = {
      "kept order": kept.orderId,
      "kept authorisation": kept.authorization.id,
      "kept authorisation created": kept.authorization.create_time ?? null,
      "kept authorisation expires": kept.authorization.expiration_time ?? null,
      "honour period ends (create_time + 3 days)": ends,
    };
    const tried = await attempt(() =>
      reauthorizeAuthorization(
        context.client,
        kept.authorization.id,
        context.requestId("kept", "reauthorize.early"),
      ),
    );
    if (tried.ok) {
      context.holds.record("kept.reauthorised", kept.orderId, tried.value.id);
      observations["reauthorisation accepted as"] = tried.value.id;
      observations["reauthorisation status"] = tried.value.status;
    } else {
      context.holds.keep(
        kept.authorization.id,
        `P5 (b): reauthorise on or after ${P5_LATER_DATE} (honour period ends ${ends ?? "unread"})`,
      );
      observations["reauthorisation refused, HTTP"] = tried.error.status;
      observations["reauthorisation refused, name"] = tried.error.name;
      observations["reauthorisation refused, issue"] = issues(tried.error);
      observations["reauthorisation refused, description"] =
        tried.error.details[0]?.description ?? tried.error.message;
      observations["reauthorisation refused, debug id"] = tried.error.debugId;
    }
    const keptAfter = await getAuthorization(context.client, kept.authorization.id);
    observations["kept authorisation status after the attempt"] = keptAfter.status;

    await negativeTest(context, observations);

    return {
      verdict: tried.ok ? "fail" : "pass",
      summary: tried.ok
        ? `PayPal reauthorised the fresh hold ${kept.authorization.id} at once, as ${tried.value.id}.`
        : `PayPal refused to reauthorise the fresh hold ${kept.authorization.id}: HTTP ${tried.error.status} ${tried.error.name} (${issues(tried.error)}). The hold stands for P5 (b).`,
      observations,
      branch: tried.ok ? BRANCH_A : null,
    };
  },
};

/**
 * Captures a fresh £1.00 hold in full with the negative-testing header asking
 * for an expired authorisation, recording what PayPal answers. A final, full
 * capture, so the hold is closed whether or not the mock is honoured.
 *
 * @param context - The run's context.
 * @param observations - Where the answer is recorded.
 */
async function negativeTest(
  context: ProbeContext,
  observations: Record<string, Observation>,
): Promise<void> {
  const hold = await makeWalletHold(context, "negative", gbp(100));
  observations["negative-test authorisation"] = hold.authorization.id;
  const mocked = await attempt(() =>
    captureAuthorization(context.client, hold.authorization.id, {
      finalCapture: true,
      requestId: context.requestId("negative", "capture.mocked"),
      headers: { "paypal-mock-response": NEGATIVE_TEST },
    }),
  );
  if (mocked.ok) {
    observations["negative test"] =
      `not honoured: captured ${mocked.value.id} ${mocked.value.status}`;
  } else {
    observations["negative test, HTTP"] = mocked.error.status;
    observations["negative test, issue"] = issues(mocked.error);
    observations["negative test, description"] =
      mocked.error.details[0]?.description ?? mocked.error.message;
  }
  const after = await getAuthorization(context.client, hold.authorization.id);
  observations["negative-test authorisation status after"] = after.status;
}

/**
 * Answers "owed" before the date a later part of P5 runs.
 *
 * @param context - The run's context.
 * @param part - `(b)` or `(c)`.
 * @param command - The exact command that runs it.
 * @returns The owed outcome, or null when the date has come.
 */
function owedUntil(context: ProbeContext, part: string, command: string) {
  if (context.now().toISOString().slice(0, 10) >= P5_LATER_DATE) {
    return null;
  }
  return {
    verdict: "owed" as const,
    summary: `P5 ${part} reports on or after ${P5_LATER_DATE}; no PayPal call was made today.`,
    observations: { "run on or after": P5_LATER_DATE, command },
    branch: null,
  };
}

/**
 * The standing hold a run of P5 (b) or (c) works on: the first run takes the
 * first id given, the second run the second.
 *
 * @param context - The run's context.
 * @returns The authorisation's id.
 * @throws Error when no hold was given for this run.
 */
function standingHold(context: ProbeContext): string {
  const id = context.options.holds[context.options.run - 1];
  if (!id) {
    throw new Error(
      `run ${context.options.run} needs a standing hold: pass --holds=<id>,<id> (one per run)`,
    );
  }
  return id;
}

/**
 * Reauthorises a standing hold, returning the new authorisation or the refusal.
 *
 * @param context - The run's context.
 * @param id - The standing authorisation.
 * @param observations - Where the facts are recorded.
 * @returns The outcome of the attempt.
 */
async function reauthoriseStanding(
  context: ProbeContext,
  id: string,
  observations: Record<string, Observation>,
) {
  const before = await getAuthorization(context.client, id);
  const orderId =
    before.links
      ?.find((l) => l.rel === "up")
      ?.href.split("/")
      .pop() ?? `order-of-${id}`;
  context.holds.record("standing", orderId, id);
  observations["standing authorisation"] = id;
  observations["standing status before"] = before.status;
  observations["standing created"] = before.create_time ?? null;
  observations["honour period ended"] = honourPeriodEnds(before.create_time);
  const tried = await attempt(() =>
    reauthorizeAuthorization(context.client, id, context.requestId("standing", "reauthorize")),
  );
  if (tried.ok) {
    context.holds.record("reauthorised", orderId, tried.value.id);
    observations["new authorisation"] = tried.value.id;
    observations["new authorisation status"] = tried.value.status;
    observations["new authorisation expires"] = tried.value.expiration_time ?? null;
  } else {
    recordRefusal(observations, tried.error);
  }
  return tried;
}

/**
 * Records a refusal's facts.
 *
 * @param observations - Where they go.
 * @param error - The refusal.
 */
function recordRefusal(observations: Record<string, Observation>, error: PayPalError): void {
  observations["reauthorisation refused, HTTP"] = error.status;
  observations["reauthorisation refused, issue"] = issues(error);
  observations["reauthorisation refused, debug id"] = error.debugId;
}

/**
 * P5 (b). A wallet hold made on 12 October reauthorises on day 5 with a new
 * authorisation id, and a capture against the new id completes.
 */
export const p5b: Probe = {
  id: "P5B",
  title: "Reauthorisation of a wallet hold after the honour period",
  question: `On or after ${P5_LATER_DATE}, the wallet hold P5 (a) left standing reauthorises with a new authorisation id, and a full final capture against the new id completes. Pass if both hold.`,
  async run(context) {
    const owed = owedUntil(context, "(b)", "pnpm probes P5B --holds=<the two P5 (a) holds>");
    if (owed) {
      return owed;
    }
    const observations: Record<string, Observation> = {};
    const tried = await reauthoriseStanding(context, standingHold(context), observations);
    if (!tried.ok) {
      return {
        verdict: "fail",
        summary: `PayPal refused to reauthorise the standing wallet hold: ${tried.error.name} (${issues(tried.error)}).`,
        observations,
        branch: BRANCH_B,
      };
    }
    const captured = await captureAuthorization(context.client, tried.value.id, {
      finalCapture: true,
      requestId: context.requestId("reauthorised", "capture"),
    });
    observations["capture"] = captured.id;
    observations["capture status"] = captured.status;
    observations["captured (pence)"] = pence(captured.amount);
    const original = await getAuthorization(context.client, standingHold(context));
    observations["standing status after"] = original.status;
    const pass = tried.value.id !== standingHold(context) && captured.status === "COMPLETED";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `The standing hold reauthorised as ${tried.value.id}; its capture ${captured.id} completed.`
        : `The reauthorisation answered ${tried.value.id} and the capture ${captured.status}.`,
      observations,
      branch: pass ? null : BRANCH_B,
    };
  },
};

/**
 * P5 (c). A card hold's reauthorisation is refused (the API documents
 * reauthorisation for PayPal-account payments).
 */
export const p5c: Probe = {
  id: "P5C",
  title: "Reauthorisation of a card hold",
  question: `On or after ${P5_LATER_DATE}, reauthorising the card hold P6 left standing is refused. Pass if refused; the refusal's name is recorded.`,
  async run(context) {
    const owed = owedUntil(context, "(c)", "pnpm probes P5C --holds=<the card holds P6 left>");
    if (owed) {
      return owed;
    }
    const observations: Record<string, Observation> = {};
    const tried = await reauthoriseStanding(context, standingHold(context), observations);
    return {
      verdict: tried.ok ? "fail" : "pass",
      summary: tried.ok
        ? `PayPal reauthorised the card hold as ${tried.value.id}.`
        : `PayPal refused to reauthorise the card hold: ${tried.error.name} (${issues(tried.error)}).`,
      observations,
      branch: tried.ok ? BRANCH_C : null,
    };
  },
};
