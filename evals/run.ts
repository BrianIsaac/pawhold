import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOpenAIModel } from "../src/agent/openai";
import { createRecordedModel, fileRecordedStore, recordedThenLive } from "../src/agent/recorded";
import { openaiEnvironment, readEnvironment } from "../src/env";

import { type EvalResult, loadNoteSets, runEval } from "./grade";

/*
 * The estimate agent's eval (plan 3.4; U4).
 *
 *   pnpm eval                 replays the answers recorded in evals/recorded/
 *   pnpm eval --live          asks OpenAI for any set not yet recorded, and records it
 *   pnpm eval --require-all   fails when a set has no recorded answer
 *   pnpm eval --write-results writes the summary to evals/results.json
 *   pnpm eval --only=01-dental-plan-example,02-cat-spay   runs only those sets
 *
 * The live run needs OPENAI_API_KEY in this process's environment only; it
 * is never printed. It exits non-zero when anything is invented or the model
 * failed on a set, and with --require-all when any set has no recording.
 * --write-results is refused with --only, so a partial run never overwrites
 * the full results.
 */

const args = new Set(process.argv.slice(2));
if (args.has("--write-results") && [...args].some((arg) => arg.startsWith("--only="))) {
  throw new Error("--write-results writes the full results: run it without --only");
}
const only = [...args]
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const live = args.has("--live");
const store = fileRecordedStore(fileURLToPath(new URL("./recorded/", import.meta.url)));
const model = live
  ? recordedThenLive(
      store,
      createOpenAIModel({ apiKey: readEnvironment(openaiEnvironment).OPENAI_API_KEY }),
    )
  : createRecordedModel(store);

const sets = loadNoteSets().filter((set) => !only || only.includes(set.id));
const result = await runEval(sets, model, { concurrency: live ? 5 : 1 });
report(result, live ? "live (recorded answers replayed, the rest asked and recorded)" : "recorded");

if (args.has("--write-results")) {
  const { graded, ...summary } = result;
  writeFileSync(
    new URL("./results.json", import.meta.url),
    `${JSON.stringify({ ...summary, graded }, null, 2)}\n`,
  );
}

const invented = result.hardBar.inventedCodes + result.hardBar.inventedSpans > 0;
const missing = args.has("--require-all") && result.notRecorded.length > 0;
process.exitCode = invented || result.failures.length > 0 || missing ? 1 : 0;

/**
 * Prints the run's result.
 *
 * @param result - The result.
 * @param mode - How the answers were had.
 */
function report(result: EvalResult, mode: string): void {
  const ratio = (value: number | null, part: number, whole: number): string =>
    value === null ? "n/a" : `${value.toFixed(3)} (${part} of ${whole})`;
  const lines = [
    `pawhold estimate eval, ${result.date}`,
    `model ${result.model}, reasoning effort ${result.reasoningEffort}; served by ${result.servedModels.join(", ") || "none"}; ${mode}`,
    `sets ${result.sets}, answered ${result.answered}, not recorded ${result.notRecorded.length}, model failures ${result.failures.length}`,
    `hard bar: ${result.hardBar.met ? "MET" : result.hardBar.inventedCodes + result.hardBar.inventedSpans > 0 ? "NOT MET" : "NOT JUDGED (a set has no answer)"} (${result.hardBar.inventedCodes} invented codes, ${result.hardBar.inventedSpans} invented spans)`,
    `code recall ${ratio(result.recall, result.expectedFound, result.expectedTotal)}`,
    `code precision ${ratio(result.precision, result.keptCorrect, result.keptTotal)}`,
    `owner's wording fallen back to the item's name: ${result.wordingFallbacks}`,
    `phrases with no item named as unmatched: ${result.unmatchedNamed} of ${result.unmatchedTotal}`,
    "",
    ...result.graded.map((set) => {
      const notes = [
        set.failure ? `FAILED ${set.failure}` : null,
        set.inventedCodes.length ? `INVENTED CODES ${set.inventedCodes.join(", ")}` : null,
        set.inventedSpans.length
          ? `INVENTED SPANS ${set.inventedSpans.map((span) => JSON.stringify(span)).join(", ")}`
          : null,
        set.missedCodes.length ? `missed ${set.missedCodes.join(", ")}` : null,
        set.wrongCodes.length ? `not expected ${set.wrongCodes.join(", ")}` : null,
      ].filter((note) => note !== null);
      return `${set.id}: found ${set.expectedFound}/${set.expectedTotal}, correct ${set.keptCorrect}/${set.keptTotal}${notes.length ? `; ${notes.join("; ")}` : ""}`;
    }),
    ...result.notRecorded.map((id) => `${id}: not recorded`),
  ];
  console.info(lines.join("\n"));
}
