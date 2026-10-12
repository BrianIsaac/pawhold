import type { Probe, ProbeId } from "./probe";
import { p1 } from "./p1-gb-pair";
import { p2 } from "./p2-capture-less";
import { p3 } from "./p3-two-captures";
import { p4 } from "./p4-void-after-capture";
import { p7 } from "./p7-two-orders";
import { smoke } from "./smoke";

/** Every probe, by id, in the order the brief runs them. */
export const PROBES: ReadonlyMap<ProbeId, Probe> = new Map(
  [smoke, p1, p2, p3, p4, p7].map((probe) => [probe.id, probe]),
);
