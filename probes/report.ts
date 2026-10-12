import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Observation, Probe, Verdict } from "./probe";
import { assertNoSecrets } from "./redact";
import type { Exchange } from "./recorder";
import type { ProbeRun } from "./run-once";

/*
 * The report writer. Each probe owns one section of the report, between its
 * markers, rewritten whole on every run of that probe; everything outside
 * the markers (the summary, the findings, "What changed for U3") is the
 * author's and is never touched.
 */

/** Where new sections go when the report holds this marker; the end otherwise. */
export const APPEND_MARKER = "<!-- probes:sections-end -->";

const begin = (id: string): string => `<!-- probe:${id}:begin -->`;
const end = (id: string): string => `<!-- probe:${id}:end -->`;

/**
 * The verdict across a probe's runs: the runs' verdict when they agree,
 * otherwise null.
 *
 * @param runs - The runs.
 * @returns The agreed verdict, or null.
 */
export function agreedVerdict(runs: readonly ProbeRun[]): Verdict | null {
  const verdicts = new Set(runs.map((r) => r.outcome?.verdict ?? null));
  const [only] = verdicts;
  return verdicts.size === 1 && only ? only : null;
}

/**
 * Renders a probe's section: the question, the dated verdict, the branch on
 * a "no", and per run its requests and PayPal's answers, the buyer's steps
 * and the clean-up check.
 *
 * @param probe - The probe.
 * @param runs - Its runs, in order.
 * @returns The section's Markdown, markers included.
 */
export function renderSection(probe: Probe, runs: readonly ProbeRun[]): string {
  const agreed = agreedVerdict(runs);
  const date = runs[0] ? longDate(runs[0].startedAt) : "not run";
  const tally = runs.map((r, i) => `run ${i + 1} ${r.outcome?.verdict ?? "broke"}`).join(", ");
  const branch = runs.find((r) => r.outcome?.branch)?.outcome?.branch ?? null;
  const reached = runs.filter((r) => r.outcome !== null).length;
  const lines = [
    begin(probe.id),
    `### ${probe.id}. ${probe.title}`,
    "",
    "<!-- written by `pnpm probes`; edits between the markers are overwritten -->",
    "",
    `Question: ${probe.question}`,
    "",
    `**Verdict: ${agreed ?? (reached === 0 ? "no verdict" : "runs disagree")}**, ${date} (${tally}${runs.length > 1 && reached > 0 ? (agreed ? ": the runs agree" : ": the runs DISAGREE") : ""}).`,
    ...(branch ? ["", `The plan's branch taken: ${branch}`] : []),
    ...runs.flatMap((run, i) => renderRun(run, i + 1, runs.length)),
    end(probe.id),
  ];
  return lines.join("\n");
}

/**
 * Renders one run.
 *
 * @param run - The run.
 * @param index - Its number, from 1.
 * @param of - How many runs there were.
 * @returns The run's lines.
 */
function renderRun(run: ProbeRun, index: number, of: number): string[] {
  const lines = [
    "",
    `#### Run ${index} of ${of}, ${clock(run.startedAt)} to ${clock(run.endedAt)} UTC`,
    "",
  ];
  if (run.outcome) {
    lines.push(`${run.outcome.verdict}: ${run.outcome.summary}`, "");
    const entries = Object.entries(run.outcome.observations);
    if (entries.length > 0) {
      lines.push(...entries.map(([k, v]) => `- ${k}: ${formatObservation(v)}`), "");
    }
  }
  if (run.error) {
    lines.push(`The run broke before a verdict: ${run.error}`, "");
  }
  if (run.options.holds.length > 0) {
    lines.push(`Holds given: ${run.options.holds.join(", ")}`, "");
  }
  if (run.exchanges.length > 0) {
    lines.push(
      "| Time (UTC) | ms | Request | Request id | Status | PayPal's answer | debug_id |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...run.exchanges.map(
        (x) =>
          `| ${clock(x.at)} | ${x.ms} | ${x.method} ${x.path}${headerNote(x)} | ${x.requestId ? `\`${x.requestId.slice(0, 8)}\`` : ""} | ${x.status ?? "no answer"} | ${cell(answerSummary(x))} | ${x.debugId ? `\`${x.debugId}\`` : ""} |`,
      ),
      "",
    );
  }
  for (const event of run.buyer) {
    if (event.kind === "approval") {
      const a = event.value;
      lines.push(
        `- Buyer approval from ${clock(a.startedAt)} UTC, ${a.seconds} s, ${a.signedIn ? "signed in" : "already signed in"}, funding ${a.funding ?? "unread"}${a.notice ? `; the review page: "${a.notice}"` : ""}`,
      );
    } else if (event.kind === "card") {
      const c = event.value;
      lines.push(
        `- Card fields from ${clock(c.startedAt)} UTC, ${c.seconds} s: eligible for GBP ${c.eligible === null ? `unread${c.eligibilityError ? ` (${c.eligibilityError})` : ""}` : String(c.eligible)}; submit ${c.state ?? "not reached"}${c.data ? `, data \`${JSON.stringify(c.data)}\`` : ""}${c.error ? `; ${c.error}` : ""}`,
      );
    } else {
      const r = event.value;
      lines.push(
        `- Buyer's account read at ${clock(r.at)} UTC (${r.page}): ${r.entries.length} entries${
          r.entries.length > 0
            ? `; first: ${r.entries
                .slice(0, 4)
                .map((e) => `"${e}"`)
                .join("; ")}`
            : ""
        }`,
      );
    }
  }
  if (run.buyer.length > 0) {
    lines.push("");
  }
  if (run.notes.length > 0) {
    lines.push(...run.notes.map((n) => `- ${clock(n.at)} ${n.text}`), "");
  }
  if (run.cleanup) {
    lines.push(
      `Clean-up check: ${run.cleanup.clean ? "clean" : "NOT CLEAN"}${run.cleanup.rows.length === 0 ? " (no authorisation made)" : ""}`,
      ...run.cleanup.rows.map(
        (r) =>
          `- ${r.authorizationId ? `\`${r.authorizationId}\`` : `order \`${r.orderId}\``} ${r.status}${r.kept ? ` (kept: ${r.kept})` : ""}${r.ok ? "" : " NOT CLOSED"}`,
      ),
    );
  } else {
    lines.push("Clean-up check: did not run");
  }
  return lines;
}

/**
 * What PayPal answered, in a few words: the resource's id, status and
 * amount, the ids nested in an order, or an error's name and issues.
 *
 * @param x - The exchange.
 * @returns The summary.
 */
export function answerSummary(x: Exchange): string {
  if (x.path === "/v1/oauth2/token") {
    return x.status === 200 ? "token (not kept)" : "token refused";
  }
  const body = x.responseBody;
  if (body === null) {
    return x.status === 204 ? "no content" : "";
  }
  if (typeof body !== "object") {
    return String(body).slice(0, 80);
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name === "string" && (x.status ?? 0) >= 400) {
    const details = Array.isArray(b.details)
      ? (b.details as { issue?: unknown }[]).map((d) => String(d.issue)).join(", ")
      : "";
    return `${b.name}${details ? `: ${details}` : ""}`;
  }
  const parts = [`${String(b.id ?? "")} ${String(b.status ?? "")}`.trim()];
  const amount = b.amount as { value?: unknown; currency_code?: unknown } | undefined;
  if (amount?.value !== undefined) {
    parts.push(`${String(amount.currency_code)} ${String(amount.value)}`);
  }
  if (typeof b.final_capture === "boolean") {
    parts.push(`final_capture ${String(b.final_capture)}`);
  }
  const units = Array.isArray(b.purchase_units)
    ? (b.purchase_units as { payments?: Record<string, unknown> }[])
    : [];
  for (const unit of units) {
    for (const [kind, list] of Object.entries(unit.payments ?? {})) {
      if (Array.isArray(list)) {
        for (const item of list as { id?: unknown; status?: unknown }[]) {
          parts.push(`${kind.replace(/s$/, "")} ${String(item.id)} ${String(item.status)}`);
        }
      }
    }
  }
  return parts.filter(Boolean).join("; ");
}

/**
 * The request headers that changed PayPal's behaviour, for the request cell.
 *
 * @param x - The exchange.
 * @returns A note, or nothing.
 */
function headerNote(x: Exchange): string {
  const mock = x.sentHeaders["paypal-mock-response"];
  return mock ? ` (mock: \`${mock}\`)` : "";
}

/**
 * Escapes a table cell.
 *
 * @param text - The text.
 * @returns The text, safe in a Markdown table.
 */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * An observation as text.
 *
 * @param value - The observation.
 * @returns Its text.
 */
function formatObservation(value: Observation): string {
  return value === null ? "none" : typeof value === "string" ? `\`${value}\`` : String(value);
}

/**
 * The time of day of an ISO instant, in UTC, to the millisecond.
 *
 * @param iso - The instant.
 * @returns `HH:MM:SS.mmm`.
 */
function clock(iso: string): string {
  return iso.slice(11, 23);
}

/**
 * A date as the report writes it.
 *
 * @param iso - An instant.
 * @returns Such as `12 October 2026`.
 */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Puts a probe's section into the report's text: in place of its earlier
 * section, else before `APPEND_MARKER`, else at the end.
 *
 * @param report - The report's text.
 * @param id - The probe's id.
 * @param section - The section, markers included.
 * @returns The new text.
 */
export function upsertSection(report: string, id: string, section: string): string {
  const from = report.indexOf(begin(id));
  const to = report.indexOf(end(id));
  if (from !== -1 && to > from) {
    return `${report.slice(0, from)}${section}${report.slice(to + end(id).length)}`;
  }
  const at = report.indexOf(APPEND_MARKER);
  if (at !== -1) {
    return `${report.slice(0, at)}${section}\n\n${report.slice(at)}`;
  }
  return `${report.replace(/\n*$/, "")}\n\n${section}\n`;
}

/**
 * Writes a probe's section into the report file, refusing to write if the
 * result holds a secret.
 *
 * @param path - The report's path.
 * @param id - The probe's id.
 * @param section - The section.
 * @param secrets - The values that must not appear.
 */
export function writeSection(
  path: string,
  id: string,
  section: string,
  secrets: readonly string[],
): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "# Sandbox probes\n";
  const next = upsertSection(current, id, section);
  writeFileSync(path, assertNoSecrets(next, secrets, `the report ${path}`));
}
