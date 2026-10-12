import type { ActivityReading, BuyerSession } from "./buyer";
import {
  approvalUrl,
  authorizeOrder,
  captureAuthorization,
  createAuthorizeOrder,
  onlyAuthorization,
  pence,
} from "./paypal";
import { gbp, type Observation, type Probe, type ProbeContext } from "./probe";

/** The plan's bar: the account shows each within a minute. */
const WITHIN_SECONDS = 60;
/** How long to keep reading before calling it not shown. */
const GIVE_UP_SECONDS = 180;
const READ_EVERY_MS = 10_000;

const BRANCH = "The video shows pawhold's timeline and the webhook ticks, not the buyer's account.";

/**
 * How an amount in pence is written on the buyer's account pages.
 *
 * @param amount - The amount in pence.
 * @returns Such as `£12.34`.
 */
export function shownAs(amount: number): string {
  const pounds = Math.trunc(amount / 100).toLocaleString("en-GB");
  return `£${pounds}.${String(amount % 100).padStart(2, "0")}`;
}

/** The first reading that showed what was looked for. */
interface Sighting {
  readonly reading: ActivityReading | null;
  readonly entry: string | null;
  readonly readings: number;
}

/**
 * Reads the buyer's activity until an entry holds the amount and the word
 * looked for, or the time runs out.
 *
 * @param context - The run's context.
 * @param session - The signed-in browser session.
 * @param since - PayPal's `create_time` for the hold or the capture.
 * @param amount - The amount, as the account writes it.
 * @param kind - The word on the entry: `Authorisation` or `Payment`.
 * @returns The sighting.
 */
async function watchFor(
  context: ProbeContext,
  session: BuyerSession,
  since: number,
  amount: string,
  kind: RegExp,
): Promise<Sighting> {
  for (let readings = 1; ; readings += 1) {
    const reading = await session.activity();
    const entry = reading.entries.find((e) => e.includes(amount) && kind.test(e)) ?? null;
    if (entry) {
      return { reading, entry, readings };
    }
    if ((Date.parse(reading.at) - since) / 1000 > GIVE_UP_SECONDS) {
      return { reading: null, entry: null, readings };
    }
    await context.sleep(READ_EVERY_MS);
  }
}

/**
 * Seconds from PayPal's time for an event to the reading that showed it.
 *
 * @param since - PayPal's `create_time`, in milliseconds.
 * @param sighting - The sighting.
 * @returns The seconds, or null when it was not seen.
 */
function lag(since: number, sighting: Sighting): number | null {
  return sighting.reading ? Math.round((Date.parse(sighting.reading.at) - since) / 1000) : null;
}

/**
 * P9. The buyer's sandbox account shows the hold, then the capture, within a
 * minute. One headless session approves the order (as the owner would) and
 * then reads the account's summary page while the probe authorises and
 * captures through the API.
 */
export const p9: Probe = {
  id: "P9",
  title: "The sandbox account shows it",
  question: `Does the buyer's own sandbox account (www.sandbox.paypal.com, the summary's recent activity) show the hold and then the capture, each within ${WITHIN_SECONDS} s of PayPal's \`create_time\` for it? Pass if both do.`,
  async run(context) {
    const asked = 1_000 + (Math.trunc(context.now().getTime() / 1000) % 9_000);
    return context.buyer.session(async (session) => {
      const created = await createAuthorizeOrder(context.client, {
        amount: gbp(asked),
        referenceId: "probe-p9",
        customId: "pawhold-probe-p9",
        requestId: context.requestId("p9", "order.create"),
      });
      await session.approve(approvalUrl(created));
      context.holds.order("p9", created.id);
      const authorization = onlyAuthorization(
        await authorizeOrder(
          context.client,
          created.id,
          context.requestId("p9", "order.authorize"),
        ),
      );
      context.holds.authorised(created.id, authorization.id);
      const amount = pence(authorization.amount) ?? asked;
      const written = shownAs(amount);
      const heldAt = Date.parse(authorization.create_time ?? "");
      const hold = await watchFor(context, session, heldAt, written, /authori[sz]ation/i);

      const capture = await captureAuthorization(context.client, authorization.id, {
        finalCapture: true,
        requestId: context.requestId("p9", "capture"),
      });
      const capturedAt = Date.parse(capture.create_time ?? "");
      const paid = await watchFor(context, session, capturedAt, written, /payment/i);

      const holdLag = lag(heldAt, hold);
      const paidLag = lag(capturedAt, paid);
      const observations: Record<string, Observation> = {
        order: created.id,
        authorization: authorization.id,
        amount: written,
        "authorisation create_time": authorization.create_time ?? null,
        "hold shown as": hold.entry,
        "seconds to show the hold": holdLag,
        "readings until the hold showed": hold.readings,
        capture: capture.id,
        "capture status": capture.status,
        "capture create_time": capture.create_time ?? null,
        "capture shown as": paid.entry,
        "seconds to show the capture": paidLag,
        "readings until the capture showed": paid.readings,
      };
      const pass =
        holdLag !== null &&
        holdLag <= WITHIN_SECONDS &&
        paidLag !== null &&
        paidLag <= WITHIN_SECONDS;
      return {
        verdict: pass ? "pass" : "fail",
        summary: pass
          ? `The buyer's account showed the ${written} hold ${holdLag} s after it was made ("${hold.entry}") and the capture ${paidLag} s after it ("${paid.entry}").`
          : `The buyer's account showed the hold after ${holdLag ?? "never"} s and the capture after ${paidLag ?? "never"} s (bar ${WITHIN_SECONDS} s).`,
        observations,
        branch: pass ? null : BRANCH,
      };
    });
  },
};
