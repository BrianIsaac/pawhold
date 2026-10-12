import "server-only";

import { agentFromEnvironment, type ServerAgent } from "@/agent/environment";
import { createDatabase, type Database } from "@/db/client";
import {
  databaseEnvironment,
  paypalEnvironment,
  readEnvironment,
  sessionEnvironment,
  webhookEnvironment,
} from "@/env";
import { createHealthHandler } from "@/health/handler";
import { createJudgeSessionHandlers } from "@/judge/session";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { createOwnerHandlers } from "@/owner/handlers";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";
import { createWebhookHandler } from "@/paypal/webhook-handler";
import { createCertificateCache } from "@/paypal/webhooks";

import { seedFictionalPractice } from "../../seed/practice";

/**
 * The server's long-lived pieces, built on first use from the environment and
 * kept on `globalThis` so development reloads do not open a pool per edit.
 */
interface Runtime {
  database?: Database;
  paypal?: PayPalClient | null;
  webhookHandler?: (request: Request) => Promise<Response>;
  judgeSessions?: ReturnType<typeof createJudgeSessionHandlers>;
  health?: () => Promise<Response>;
  agent?: ServerAgent;
  owner?: ReturnType<typeof createOwnerHandlers>;
}

const holder = globalThis as typeof globalThis & { __pawholdRuntime?: Runtime };
const runtime: Runtime = (holder.__pawholdRuntime ??= {});

/**
 * The application's database.
 *
 * @returns The database handle.
 * @throws EnvironmentError when `DATABASE_URL` is missing.
 */
export function database(): Database {
  runtime.database ??= createDatabase(readEnvironment(databaseEnvironment).DATABASE_URL);
  return runtime.database;
}

/**
 * The PayPal client, or null when the sandbox app's credentials are not set
 * (before the operator's PayPal account exists).
 *
 * @returns The client, or null.
 */
export function paypalClient(): PayPalClient | null {
  if (runtime.paypal === undefined) {
    const parsed = paypalEnvironment.safeParse(process.env);
    runtime.paypal = parsed.success
      ? createPayPalClient({
          clientId: parsed.data.PAYPAL_CLIENT_ID,
          clientSecret: parsed.data.PAYPAL_CLIENT_SECRET,
          environment: parsed.data.PAYPAL_ENV,
        })
      : null;
  }
  return runtime.paypal;
}

/**
 * The webhook listener, wired to the database, the certificate cache, when
 * credentials are set the postback fallback, and the money lifecycle's
 * reconciliation of each event stored.
 *
 * @returns The request handler.
 * @throws EnvironmentError when `DATABASE_URL` or `PAYPAL_WEBHOOK_ID` is missing.
 */
export function webhookHandler(): (request: Request) => Promise<Response> {
  if (!runtime.webhookHandler) {
    const webhook = readEnvironment(webhookEnvironment);
    const postback = paypalClient();
    runtime.webhookHandler = createWebhookHandler({
      db: database().db,
      webhookId: webhook.PAYPAL_WEBHOOK_ID,
      certificates: createCertificateCache(),
      acceptMockEvents: webhook.PAYPAL_ACCEPT_MOCK_WEBHOOKS,
      ...(postback ? { postback } : {}),
      onStored: async (eventId) => {
        await reconcileWebhookEvent(database().db, eventId);
      },
    });
  }
  return runtime.webhookHandler;
}

/**
 * The secret judge-mode session cookies are signed with.
 *
 * @returns The secret.
 * @throws EnvironmentError when `SESSION_SECRET` is missing or short.
 */
export function sessionSecret(): string {
  return readEnvironment(sessionEnvironment).SESSION_SECRET;
}

/**
 * The judge-mode session endpoints, each new practice seeded as the
 * fictional practice with its price list (D2).
 *
 * @returns The handlers.
 * @throws EnvironmentError when `DATABASE_URL` or `SESSION_SECRET` is missing.
 */
export function judgeSessionHandlers(): ReturnType<typeof createJudgeSessionHandlers> {
  runtime.judgeSessions ??= createJudgeSessionHandlers({
    db: database().db,
    secret: sessionSecret(),
    seed: seedFictionalPractice,
    secureCookie: process.env.NODE_ENV === "production",
  });
  return runtime.judgeSessions;
}

/**
 * The health check, reporting the commit Render deployed.
 *
 * @returns The handler.
 */
export function healthHandler(): () => Promise<Response> {
  runtime.health ??= createHealthHandler({
    database,
    commit: process.env.RENDER_GIT_COMMIT ?? null,
  });
  return runtime.health;
}

/**
 * The estimate agent (U4): OpenAI's `gpt-6.1-sol` when `OPENAI_API_KEY` is
 * set, else every draft is an empty estimate; the per-session cap from
 * `AGENT_DRAFTS_PER_HOUR` (D8).
 *
 * @returns The agent's dependencies, for `draftEstimate` and `draftUpdate`.
 * @throws EnvironmentError when `DATABASE_URL` is missing or the cap is malformed.
 */
export function estimateAgent(): ServerAgent {
  runtime.agent ??= agentFromEnvironment(database().db);
  return runtime.agent;
}

/**
 * The owner's endpoints under `/e/{token}/` (U6): the order, the
 * authorisation, the hold's status and the decline.
 *
 * @returns The handlers.
 * @throws EnvironmentError when `DATABASE_URL` or `SESSION_SECRET` is missing.
 */
export function ownerHandlers(): ReturnType<typeof createOwnerHandlers> {
  runtime.owner ??= createOwnerHandlers({
    db: database().db,
    paypal: paypalClient,
    secret: sessionSecret(),
  });
  return runtime.owner;
}

/**
 * The sandbox app's client id for the owner's page, the one PayPal value
 * that reaches the browser; null when the app's credentials are not set.
 *
 * @returns The client id, or null.
 */
export function paypalBrowserClientId(): string | null {
  const parsed = paypalEnvironment.safeParse(process.env);
  return parsed.success ? parsed.data.PAYPAL_CLIENT_ID : null;
}
