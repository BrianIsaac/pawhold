import { existsSync, readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/*
 * render.yaml as Render reads it (plan 7.1 to 7.3, U10): every resource on a
 * paid plan so nothing sleeps or expires before 16 December, the cron job
 * hourly, Render's health check on the route that reaches the database, and
 * the environment each service reads, with nothing a test bed uses.
 */

const BLUEPRINT = readFileSync(new URL("../../render.yaml", import.meta.url), "utf8");

const envVar = z.union([
  z.object({ key: z.string(), value: z.string() }).strict(),
  z.object({ key: z.string(), sync: z.literal(false) }).strict(),
  z.object({ key: z.string(), generateValue: z.literal(true) }).strict(),
  z
    .object({
      key: z.string(),
      fromDatabase: z.object({ name: z.string(), property: z.string() }).strict(),
    })
    .strict(),
]);

const service = z.object({
  type: z.enum(["web", "cron"]),
  name: z.string(),
  runtime: z.string(),
  region: z.string(),
  plan: z.string().optional(),
  branch: z.string(),
  schedule: z.string().optional(),
  healthCheckPath: z.string().optional(),
  envVars: z.array(envVar),
});

const blueprint = z.object({
  services: z.array(service),
  databases: z.array(
    z.object({
      name: z.string(),
      region: z.string(),
      plan: z.string().optional(),
      postgresMajorVersion: z.string(),
    }),
  ),
});

type Service = z.infer<typeof service>;

const parsed = blueprint.parse(parse(BLUEPRINT));

/**
 * The one service of a type in the Blueprint.
 *
 * @param type - The service's type.
 * @returns The service.
 */
function only(type: Service["type"]): Service {
  const found = parsed.services.filter((one) => one.type === type);
  expect(found, `one ${type} service`).toHaveLength(1);
  return found[0]!;
}

/**
 * The keys a service's environment declares.
 *
 * @param one - The service.
 * @returns The keys, sorted.
 */
function keys(one: Service): string[] {
  return one.envVars.map((variable) => variable.key).sort();
}

/**
 * How a service's variable is given: its value, `sync: false`, generated or
 * from the database.
 *
 * @param one - The service.
 * @param key - The variable.
 * @returns The variable's declaration.
 */
function declared(one: Service, key: string): z.infer<typeof envVar> | undefined {
  return one.envVars.find((variable) => variable.key === key);
}

describe("render.yaml (U10)", () => {
  it("puts every service and the database on a named paid plan, none free", () => {
    const plans = [...parsed.services, ...parsed.databases].map((one) => [one.name, one.plan]);

    expect(plans).toEqual([
      ["pawhold", "0.5c-512mb"],
      ["pawhold-hourly", "0.5c-512mb"],
      ["pawhold-db", "0.1c-256mb"],
    ]);
    expect(plans.filter(([, plan]) => plan === undefined || /free/i.test(plan))).toEqual([]);
  });

  it("runs the cron job once an hour, every hour", () => {
    const fields = only("cron").schedule?.trim().split(/\s+/);

    expect(fields).toHaveLength(5);
    const [minute, ...rest] = fields!;
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    expect(Number(minute)).toBeLessThan(60);
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(rest).toEqual(["*", "*", "*", "*"]);
  });

  it("points Render's health check at the route that reaches the database", () => {
    expect(only("web").healthCheckPath).toBe("/api/health");
    expect(existsSync(new URL("../../app/api/health/route.ts", import.meta.url))).toBe(true);
  });

  it("keeps the services beside their database, in one region", () => {
    const regions = new Set([...parsed.services, ...parsed.databases].map((one) => one.region));

    expect([...regions]).toEqual(["frankfurt"]);
    expect(parsed.databases.map((one) => one.postgresMajorVersion)).toEqual(["17"]);
  });

  it("gives the web service what it reads, the sandbox buyer's login included", () => {
    expect(keys(only("web"))).toEqual([
      "AGENT_DRAFTS_PER_HOUR",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "PAYPAL_ACCEPT_MOCK_WEBHOOKS",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_ENV",
      "PAYPAL_SANDBOX_BUYER_EMAIL",
      "PAYPAL_SANDBOX_BUYER_PASSWORD",
      "PAYPAL_WEBHOOK_ID",
      "SESSION_SECRET",
    ]);
    for (const secret of [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_SANDBOX_BUYER_EMAIL",
      "PAYPAL_SANDBOX_BUYER_PASSWORD",
      "OPENAI_API_KEY",
    ]) {
      expect(declared(only("web"), secret), secret).toEqual({ key: secret, sync: false });
    }
    expect(declared(only("web"), "SESSION_SECRET")).toEqual({
      key: "SESSION_SECRET",
      generateValue: true,
    });
  });

  it("judges in the sandbox, refuses mock webhooks and keeps the draft cap of D8", () => {
    expect(declared(only("web"), "PAYPAL_ENV")).toEqual({ key: "PAYPAL_ENV", value: "sandbox" });
    expect(declared(only("web"), "PAYPAL_ACCEPT_MOCK_WEBHOOKS")).toEqual({
      key: "PAYPAL_ACCEPT_MOCK_WEBHOOKS",
      value: "false",
    });
    expect(declared(only("web"), "AGENT_DRAFTS_PER_HOUR")).toEqual({
      key: "AGENT_DRAFTS_PER_HOUR",
      value: "40",
    });
  });

  it("gives the cron job the database and PayPal's credentials, for the reauthorisation rule and the clean-up", () => {
    expect(keys(only("cron"))).toEqual([
      "COREPACK_ENABLE_DOWNLOAD_PROMPT",
      "DATABASE_URL",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_ENV",
    ]);
    expect(declared(only("cron"), "PAYPAL_ENV")).toEqual({ key: "PAYPAL_ENV", value: "sandbox" });
  });

  it("sets nothing a test bed uses: no PayPal double, no recorded model", () => {
    const everywhere = parsed.services.flatMap(keys);

    expect(everywhere).not.toContain("PAYPAL_DOUBLE_URL");
    expect(everywhere).not.toContain("AGENT_RECORDED_DIR");
  });
});
