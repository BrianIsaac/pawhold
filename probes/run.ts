import { resolve } from "node:path";

import { readEnvironment } from "../src/env";

import { createBrowserBuyer } from "./buyer";
import { probeEnvironment, secretsOf } from "./environment";
import { PROBES } from "./index";
import { PROBE_IDS, type ProbeId } from "./probe";
import { assertNoSecrets } from "./redact";
import { writeRecording } from "./replay";
import { agreedVerdict, renderSection, writeSection } from "./report";
import { type ProbeRun, runOnce } from "./run-once";

/*
 * The sandbox probes (plan section 4; U0).
 *
 *   pnpm probes                    runs every probe, twice each
 *   pnpm probes P2 P3              runs those probes
 *   pnpm probes --runs=1           runs each once
 *   pnpm probes --report=<path>    writes the report there (default
 *                                  docs/research/sandbox-probes-<today>.md)
 *   pnpm probes --record           writes run 1 of each probe to
 *                                  probes/recorded/<id>.json, for the replay tests
 *   pnpm probes P5B --holds=<id>,<id>   the holds P5 (a) left standing
 *
 * Calls PayPal's sandbox and drives a headless Chromium as the GB buyer.
 * The credentials and logins come from this process's environment only:
 *
 *   env $(grep -E '^PAYPAL_' ~/.config/briain/secrets.env | xargs) pnpm probes
 *
 * and are never printed, recorded or written to the report (every write is
 * checked for them). Exits non-zero when a run broke, when a probe's runs
 * disagree, or when a run's clean-up check finds an authorisation still open.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(flag("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs takes a whole number of at least 1");
}
const ids = args.filter((a) => !a.startsWith("--"));
const unknown = ids.filter((id) => !(PROBE_IDS as readonly string[]).includes(id));
if (unknown.length > 0) {
  throw new Error(`unknown probe(s): ${unknown.join(", ")}; known: ${PROBE_IDS.join(", ")}`);
}
const selected = (ids.length > 0 ? (ids as ProbeId[]) : [...PROBES.keys()]).map((id) => {
  const probe = PROBES.get(id);
  if (!probe) {
    throw new Error(`probe ${id} is not written yet`);
  }
  return probe;
});
const today = new Date().toISOString().slice(0, 10);
const reportPath = resolve(flag("report") ?? `docs/research/sandbox-probes-${today}.md`);
const holds = (flag("holds") ?? "").split(",").filter((h) => h.length > 0);

const env = readEnvironment(probeEnvironment);
const secrets = secretsOf(env);
const buyer = createBrowserBuyer(
  { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD },
  secrets,
);
const say = (line: string): void => console.info(assertNoSecrets(line, secrets, "a log line"));

let failed = false;
for (const probe of selected) {
  const done: ProbeRun[] = [];
  for (let n = 1; n <= runs; n += 1) {
    say(`${probe.id} run ${n} of ${runs}: started`);
    const run = await runOnce(probe, {
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      fetch,
      buyer,
      options: { holds, run: n },
    });
    done.push(run);
    say(
      `${probe.id} run ${n}: ${run.outcome ? `${run.outcome.verdict}: ${run.outcome.summary}` : `broke: ${run.error}`}; clean-up ${run.cleanup ? (run.cleanup.clean ? "clean" : "NOT CLEAN") : "did not run"}`,
    );
    failed ||= run.outcome === null || run.error !== null || !run.cleanup?.clean;
    writeSection(reportPath, probe.id, renderSection(probe, done), secrets);
    if (n === 1 && args.includes("--record")) {
      writeRecording(
        run,
        assertNoSecrets(`${JSON.stringify(run, null, 2)}\n`, secrets, "a recording"),
      );
    }
  }
  if (runs > 1 && agreedVerdict(done) === null) {
    say(`${probe.id}: the runs DISAGREE`);
    failed = true;
  }
}
say(`report: ${reportPath}`);
process.exitCode = failed ? 1 : 0;
