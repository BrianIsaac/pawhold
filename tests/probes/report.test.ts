import { describe, expect, it } from "vitest";

import type { Probe } from "../../probes/probe";
import {
  agreedVerdict,
  APPEND_MARKER,
  answerSummary,
  renderSection,
  upsertSection,
} from "../../probes/report";
import type { Exchange } from "../../probes/recorder";
import type { ProbeRun } from "../../probes/run-once";

const probe: Probe = {
  id: "P2",
  title: "Capture less than held",
  question: "Can £64.00 be captured from a £100.00 hold?",
  run: () => Promise.reject(new Error("not run here")),
};

const exchange = (over: Partial<Exchange>): Exchange => ({
  at: "2026-10-12T11:00:00.000Z",
  ms: 10,
  method: "POST",
  path: "/v2/payments/authorizations/A1/capture",
  requestId: "0123456789abcdef",
  sentHeaders: {},
  requestBody: null,
  status: 201,
  debugId: "dbg",
  responseBody: null,
  ...over,
});

const run = (verdict: "pass" | "fail", over: Partial<ProbeRun> = {}): ProbeRun => ({
  probe: "P2",
  startedAt: "2026-10-12T11:00:00.000Z",
  endedAt: "2026-10-12T11:00:30.000Z",
  options: { holds: [], run: 1 },
  outcome: {
    verdict,
    summary: "Captured £64.00.",
    observations: { "capture status": "COMPLETED", "final capture": true },
    branch: verdict === "fail" ? "Stop and re-plan before U3." : null,
  },
  error: null,
  exchanges: [
    exchange({
      responseBody: {
        id: "C1",
        status: "COMPLETED",
        amount: { currency_code: "GBP", value: "64.00" },
        final_capture: true,
      },
    }),
  ],
  buyer: [],
  notes: [],
  cleanup: {
    rows: [{ orderId: "O1", authorizationId: "A1", status: "CAPTURED", kept: null, ok: true }],
    clean: true,
  },
  ...over,
});

describe("the probe report's sections", () => {
  it("states a dated verdict, the runs' agreement and each run's requests with ids and debug ids", () => {
    const section = renderSection(probe, [run("pass"), run("pass")]);

    expect(section).toContain(
      "**Verdict: pass**, 12 October 2026 (run 1 pass, run 2 pass: the runs agree).",
    );
    expect(section).toContain(
      "| 11:00:00.000 | 10 | POST /v2/payments/authorizations/A1/capture | `01234567` | 201 | C1 COMPLETED; GBP 64.00; final_capture true | `dbg` |",
    );
    expect(section).toContain("- capture status: `COMPLETED`");
    expect(section).toContain("Clean-up check: clean\n- `A1` CAPTURED");
    expect(section.startsWith("<!-- probe:P2:begin -->")).toBe(true);
    expect(section.endsWith("<!-- probe:P2:end -->")).toBe(true);
  });

  it("says when the runs disagree, and gives the plan's branch on a no", () => {
    const section = renderSection(probe, [run("pass"), run("fail")]);

    expect(agreedVerdict([run("pass"), run("fail")])).toBeNull();
    expect(section).toContain("**Verdict: runs disagree**");
    expect(section).toContain("the runs DISAGREE");
    expect(section).toContain("The plan's branch taken: Stop and re-plan before U3.");
  });

  it("reports a run that broke and an authorisation left open", () => {
    const broke = run("pass", {
      outcome: null,
      error: "Error: buyer approval failed",
      cleanup: {
        rows: [{ orderId: "O9", authorizationId: "A9", status: "CREATED", kept: null, ok: false }],
        clean: false,
      },
    });

    const section = renderSection(probe, [broke]);

    expect(section).toContain("**Verdict: no verdict**, 12 October 2026 (run 1 broke).");
    expect(section).toContain("The run broke before a verdict: Error: buyer approval failed");
    expect(section).toContain("Clean-up check: NOT CLEAN\n- `A9` CREATED NOT CLOSED");
  });

  it("summarises an error answer by its name and issues", () => {
    expect(
      answerSummary(
        exchange({
          status: 422,
          responseBody: {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "REAUTHORIZATION_TOO_SOON" }],
          },
        }),
      ),
    ).toBe("UNPROCESSABLE_ENTITY: REAUTHORIZATION_TOO_SOON");
  });
});

describe("writing a section into the report", () => {
  const section = (text: string) => `<!-- probe:P2:begin -->\n${text}\n<!-- probe:P2:end -->`;

  it("replaces the probe's earlier section and leaves the author's text alone", () => {
    const report = `# Report\n\nMy summary.\n\n${section("old")}\n\n## What changed for U3\n`;

    expect(upsertSection(report, "P2", section("new"))).toBe(
      `# Report\n\nMy summary.\n\n${section("new")}\n\n## What changed for U3\n`,
    );
  });

  it("puts a new section before the append marker, else at the end", () => {
    expect(upsertSection(`# R\n\n${APPEND_MARKER}\n\n## U3\n`, "P2", section("x"))).toBe(
      `# R\n\n${section("x")}\n\n${APPEND_MARKER}\n\n## U3\n`,
    );
    expect(upsertSection("# R\n\n", "P2", section("x"))).toBe(`# R\n\n${section("x")}\n`);
  });
});
