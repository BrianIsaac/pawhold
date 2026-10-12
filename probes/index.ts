import type { Probe, ProbeId } from "./probe";
import { p1 } from "./p1-gb-pair";
import { p2 } from "./p2-capture-less";
import { p3 } from "./p3-two-captures";
import { p4 } from "./p4-void-after-capture";
import { p5a, p5b, p5c } from "./p5-reauthorise";
import { p6 } from "./p6-card-fields";
import { p7 } from "./p7-two-orders";
import { createP8 } from "./p8-webhooks";
import { p9 } from "./p9-buyer-account";
import { smoke } from "./smoke";
import { postgresWebhookStore } from "./webhook-store";

const p8 = createP8({
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  storeUrl: process.env.P8_DATABASE_URL,
  openStore: postgresWebhookStore,
});

/** Every probe, by id, in the order the brief runs them. */
export const PROBES: ReadonlyMap<ProbeId, Probe> = new Map(
  [smoke, p1, p2, p3, p4, p7, p5a, p5b, p5c, p6, p9, p8].map((probe) => [probe.id, probe]),
);
