import { healthAnswer } from "./target";

/*
 * After a push to `main`, Render builds and deploys it (render.yaml's
 * `autoDeployTrigger: commit`); the live smoke waits until the deployment's
 * health check reports the pushed commit with the database reached, asking
 * at an interval up to a limit (ten minutes, U10's brief), then walks.
 */

/** What to wait for. */
export interface DeploymentWait {
  /** The deployment's origin. */
  readonly baseUrl: string;
  /** The pushed commit, a full SHA. */
  readonly commit: string;
  /** How long to wait in all. */
  readonly timeoutMs: number;
  /** How long between asks. */
  readonly everyMs: number;
}

/** How the wait asks and passes time; the real ones by default. */
export interface DeploymentWaitDependencies {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** How the wait ended. */
export type DeploymentWaitResult =
  | {
      readonly deployed: true;
      readonly commit: string;
      readonly waitedMs: number;
      readonly asks: number;
    }
  | {
      readonly deployed: false;
      readonly waitedMs: number;
      readonly asks: number;
      readonly last: string;
    };

/** How long one ask may take before it counts as no answer. */
const ASK_TIMEOUT_MS = 10_000;

const REAL: DeploymentWaitDependencies = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
};

/**
 * Asks the health check once.
 *
 * @param url - The health check's address.
 * @param dependencies - How to ask.
 * @returns Whether it reports up, its commit, and what it said in words.
 */
async function ask(
  url: string,
  dependencies: DeploymentWaitDependencies,
): Promise<{ up: boolean; commit: string | null; said: string }> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      up: false,
      commit: null,
      said: `no answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  const health = healthAnswer.safeParse(body);
  if (!health.success) {
    return { up: false, commit: null, said: `${response.status}, not the health check's answer` };
  }
  const { status, database, commit } = health.data;
  return {
    up: response.status === 200 && status === "ok" && database === "reached",
    commit,
    said: `${response.status} ${status}, database ${database}, commit ${String(commit)}`,
  };
}

/**
 * Waits until the deployment's health check reports the pushed commit with
 * the database reached, or the limit passes.
 *
 * @param wait - The deployment, the commit and the limits.
 * @param dependencies - How to ask and pass time; the real ones by default.
 * @returns Deployed, with how long it took; or not, with what the deployment last said.
 * @throws Error when the commit is not a full SHA.
 */
export async function awaitDeployment(
  wait: DeploymentWait,
  dependencies: DeploymentWaitDependencies = REAL,
): Promise<DeploymentWaitResult> {
  if (!/^[0-9a-f]{40}$/.test(wait.commit)) {
    throw new Error("the pushed commit must be a full 40-character SHA");
  }
  const url = `${wait.baseUrl}/api/health`;
  const started = dependencies.now();
  let asks = 0;
  for (;;) {
    const answer = await ask(url, dependencies);
    asks += 1;
    const waitedMs = dependencies.now() - started;
    if (answer.up && answer.commit === wait.commit) {
      return { deployed: true, commit: wait.commit, waitedMs, asks };
    }
    if (waitedMs >= wait.timeoutMs) {
      return { deployed: false, waitedMs, asks, last: answer.said };
    }
    await dependencies.sleep(Math.min(wait.everyMs, wait.timeoutMs - waitedMs));
  }
}
