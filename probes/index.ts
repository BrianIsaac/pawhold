import type { Probe, ProbeId } from "./probe";
import { p1 } from "./p1-gb-pair";
import { p2 } from "./p2-capture-less";
import { p3 } from "./p3-two-captures";
import { p4 } from "./p4-void-after-capture";
import { p5a, p5b, p5c } from "./p5-reauthorise";
import { p6 } from "./p6-card-fields";
import { p7 } from "./p7-two-orders";
import { createP8, type P8Setup } from "./p8-webhooks";
import { p9 } from "./p9-buyer-account";
import { smoke } from "./smoke";
import { postgresWebhookStore } from "./webhook-store";

/**
 * Every probe, by id, in the order a full run takes them: the brief's order,
 * then the probes owed to later dates.
 *
 * @param p8 - P8's listener: its webhook id and database.
 * @returns The probes.
 */
export function buildProbes(p8: P8Setup): ReadonlyMap<ProbeId, Probe> {
  return new Map(
    [smoke, p1, p2, p3, p4, p7, p5a, p6, p9, createP8(p8), p5b, p5c].map((probe) => [
      probe.id,
      probe,
    ]),
  );
}

/** The probes with no listener given (P8 owed), for the tests. */
export const PROBES = buildProbes({
  webhookId: undefined,
  storeUrl: undefined,
  openStore: postgresWebhookStore,
});
