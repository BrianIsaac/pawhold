import { existsSync, readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/*
 * The GitHub workflows as GitHub reads them: the gate on every push and
 * pull request (U1), and the live smoke (U10) on dispatch, after each deploy
 * of `main` and on a schedule, whose thirty-minute run is the uptime check
 * (plan 7.4, D8) and whose failure is GitHub's email to the operator.
 */

/**
 * A workflow file, read as YAML.
 *
 * @param name - The file under .github/workflows.
 * @returns What it parses to.
 */
function workflowFile(name: string): unknown {
  return parse(
    readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

const step = z
  .object({
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .refine((one) => (one.uses === undefined) !== (one.run === undefined), "uses or run, not both");

const job = z
  .object({
    name: z.string().optional(),
    "runs-on": z.literal("ubuntu-24.04"),
    "timeout-minutes": z.number().int().positive(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    concurrency: z
      .object({ group: z.string(), "cancel-in-progress": z.boolean() })
      .strict()
      .optional(),
    services: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    steps: z.array(step).min(1),
  })
  .strict();

const workflow = z
  .object({
    name: z.string(),
    on: z.record(z.string(), z.unknown()),
    permissions: z.object({ contents: z.literal("read") }).strict(),
    concurrency: z
      .object({ group: z.string(), "cancel-in-progress": z.union([z.boolean(), z.string()]) })
      .strict()
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
    jobs: z.record(z.string(), job),
  })
  .strict();

type Job = z.infer<typeof job>;

/**
 * The commands a job runs, in order.
 *
 * @param one - The job.
 * @returns Each `run`, trimmed.
 */
function runs(one: Job): string[] {
  return one.steps.flatMap((each) => (each.run === undefined ? [] : [each.run.trim()]));
}

/**
 * The actions a job uses, in order.
 *
 * @param one - The job.
 * @returns Each `uses`.
 */
function uses(one: Job): string[] {
  return one.steps.flatMap((each) => (each.uses === undefined ? [] : [each.uses]));
}

const gate = workflow.parse(workflowFile("gate.yml"));
const smoke = workflow.parse(workflowFile("live-smoke.yml"));

/** The actions every job sets up with, as the gate pins them. */
const SETUP = ["actions/checkout@v7", "pnpm/action-setup@v6", "actions/setup-node@v7"];

describe("the gate workflow (U1)", () => {
  it("runs on every push and pull request", () => {
    expect(Object.keys(gate.on).sort()).toEqual(["pull_request", "push"]);
  });

  it("runs the gate's five commands in order against Postgres 17", () => {
    const only = gate.jobs.gate!;

    expect(uses(only)).toEqual(SETUP);
    expect(runs(only)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm exec playwright install --with-deps chromium",
      "pnpm test:browser",
      "pnpm build",
    ]);
    expect(only.services).toHaveProperty("postgres.image", "postgres:17-alpine");
  });
});

describe("the live smoke workflow (U10)", () => {
  const on = z
    .object({
      workflow_dispatch: z
        .object({
          inputs: z
            .object({
              base_url: z
                .object({
                  description: z.string(),
                  type: z.literal("string"),
                  required: z.literal(true),
                  default: z.string(),
                })
                .strict(),
              walk: z
                .object({
                  description: z.string(),
                  type: z.literal("boolean"),
                  required: z.literal(true),
                  default: z.boolean(),
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
      push: z.object({ branches: z.array(z.string()) }).strict(),
      schedule: z.array(z.object({ cron: z.string() }).strict()),
    })
    .strict()
    .parse(smoke.on);
  const crons = on.schedule.map((one) => one.cron);

  it("is dispatched by hand against the deployment, or another address to prove it goes red", () => {
    expect(on.workflow_dispatch.inputs.base_url.default).toBe("https://pawhold.onrender.com");
    expect(on.workflow_dispatch.inputs.walk.default).toBe(true);
    expect(smoke.env?.PAWHOLD_LIVE_URL).toBe(
      "${{ inputs.base_url || 'https://pawhold.onrender.com' }}",
    );
  });

  it("checks the deployment every thirty minutes, the uptime check", () => {
    const halfHourly = crons.filter((cron) => {
      const [minute, ...rest] = cron.split(/\s+/);
      const minutes = minute!.split(",").map(Number);
      return (
        rest.join(" ") === "* * * *" &&
        minutes.length === 2 &&
        minutes.every((one) => Number.isInteger(one) && one >= 0 && one < 60) &&
        Math.abs(minutes[1]! - minutes[0]!) === 30
      );
    });

    expect(halfHourly).toHaveLength(1);
    // Off the hour, when GitHub's scheduler is busiest and delays runs.
    expect(halfHourly[0]!.split(" ")[0]!.split(",")).not.toContain("0");
  });

  it("walks the README once a day on its own schedule", () => {
    const daily = crons.filter((cron) => /^\d{1,2} \d{1,2} \* \* \*$/.test(cron));

    expect(daily).toHaveLength(1);
    expect(smoke.jobs.walk!.if).toContain(`github.event.schedule == '${daily[0]}'`);
  });

  it("after a push to main, waits for the deployment to report the pushed commit", () => {
    expect(on.push.branches).toEqual(["main"]);
    const deployed = smoke.jobs.deployed!;

    expect(deployed.if).toBe("github.event_name == 'push'");
    expect(uses(deployed)).toEqual(SETUP);
    expect(runs(deployed)).toEqual(["pnpm install --frozen-lockfile", "pnpm live:await-deploy"]);
    expect(deployed.steps.at(-1)!.env).toEqual({ PAWHOLD_LIVE_COMMIT: "${{ github.sha }}" });
    expect(deployed["timeout-minutes"]).toBeGreaterThanOrEqual(11);
    expect(existsSync(new URL("../live/await-deploy.ts", import.meta.url))).toBe(true);
  });

  it("checks uptime with no browser, after the deploy when there was one", () => {
    const uptime = smoke.jobs.uptime!;

    expect(uptime.needs).toBe("deployed");
    expect(uptime.if).toBe(
      "${{ !failure() && !cancelled() && needs.deployed.result != 'cancelled' }}",
    );
    expect(uses(uptime)).toEqual(SETUP);
    expect(runs(uptime)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm test:live --project uptime",
    ]);
  });

  it("walks only after the uptime check passed, with the buyer's login from the repository's secrets", () => {
    const walk = smoke.jobs.walk!;

    expect(walk.needs).toBe("uptime");
    expect(walk.if).toMatch(
      /^\$\{\{ !failure\(\) && !cancelled\(\) && needs\.uptime\.result == 'success' && \(/,
    );
    expect(walk.if).toContain("github.event_name == 'push'");
    expect(walk.if).toContain("(github.event_name == 'workflow_dispatch' && inputs.walk)");
    expect(uses(walk)).toEqual(SETUP);
    expect(runs(walk)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec playwright install --with-deps chromium",
      "pnpm test:live --project walk --no-deps",
    ]);
    expect(walk.steps.at(-1)!.env).toEqual({
      PAWHOLD_SMOKE_BUYER_EMAIL: "${{ secrets.PAWHOLD_SMOKE_BUYER_EMAIL }}",
      PAWHOLD_SMOKE_BUYER_PASSWORD: "${{ secrets.PAWHOLD_SMOKE_BUYER_PASSWORD }}",
    });
  });

  it("hands the secrets to the walk's own step alone, and never echoes one", () => {
    const text = readFileSync(
      new URL("../../.github/workflows/live-smoke.yml", import.meta.url),
      "utf8",
    );

    expect(text.match(/secrets\./g)).toHaveLength(2);
    expect(Object.values(smoke.jobs).flatMap(runs).join("\n")).not.toMatch(/echo|printenv|env\b/);
  });

  it("lets a newer push's wait replace an older one's, and never cancels a check or a walk", () => {
    // A walk cut off between PayPal's approval and the discharge would leave a hold standing.
    expect(smoke.concurrency).toBeUndefined();
    expect(smoke.jobs.deployed!.concurrency).toEqual({
      group: "live-smoke-deploy",
      "cancel-in-progress": true,
    });
    expect(smoke.jobs.uptime!.concurrency).toBeUndefined();
    expect(smoke.jobs.walk!.concurrency).toBeUndefined();
  });
});
