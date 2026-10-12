import type { Probe, ProbeId } from "./probe";
import { p1 } from "./p1-gb-pair";
import { p2 } from "./p2-capture-less";
import { smoke } from "./smoke";

/** Every probe, by id, in the order the brief runs them. */
export const PROBES: ReadonlyMap<ProbeId, Probe> = new Map(
  [smoke, p1, p2].map((probe) => [probe.id, probe]),
);
