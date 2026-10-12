import type { Probe, ProbeId } from "./probe";
import { smoke } from "./smoke";

/** Every probe, by id, in the order the brief runs them. */
export const PROBES: ReadonlyMap<ProbeId, Probe> = new Map(
  [smoke].map((probe) => [probe.id, probe]),
);
