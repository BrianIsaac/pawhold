import { expect } from "vitest";

import { PROBES } from "../../probes/index";
import type { ProbeId } from "../../probes/probe";
import { readRecording, replay } from "../../probes/replay";
import type { ProbeRun } from "../../probes/run-once";

/**
 * Replays a probe's committed recording and checks that the replay asks
 * PayPal exactly what the live run asked, reaches the same verdict and
 * observations, and finds the same clean-up.
 *
 * @param id - The probe.
 * @returns The recorded run and the replayed one.
 */
export async function replayRecorded(
  id: ProbeId,
): Promise<{ recorded: ProbeRun; replayed: ProbeRun }> {
  const probe = PROBES.get(id);
  if (!probe) {
    throw new Error(`no probe ${id}`);
  }
  const recorded = readRecording(id);
  const { run, unserved } = await replay(probe, recorded);

  expect(run.error).toBeNull();
  expect(unserved).toBe(0);
  expect(run.outcome).toEqual(recorded.outcome);
  expect(run.cleanup).toEqual(recorded.cleanup);
  return { recorded, replayed: run };
}
