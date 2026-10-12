import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll } from "vitest";

/** One request the mock PayPal received. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A canned answer: a status and a JSON body. */
export interface MockAnswer {
  readonly status: number;
  readonly body: unknown;
}

type Route = (request: RecordedRequest) => MockAnswer;

/** A local HTTP server standing in for PayPal's REST API. */
export interface MockPayPal {
  /** The base URL to point the client at. */
  readonly baseUrl: () => string;
  /** Every request received since the last reset, in order. */
  readonly requests: RecordedRequest[];
  /**
   * Answers `METHOD /path` with the next answer in the list, the last one
   * repeating once the list runs out.
   */
  readonly on: (route: string, ...answers: (MockAnswer | Route)[]) => void;
}

/**
 * Starts a mock PayPal for the calling test file; routes and recorded
 * requests reset after each test.
 *
 * @returns The mock.
 */
export function startMockPayPal(): MockPayPal {
  const routes = new Map<string, (MockAnswer | Route)[]>();
  const requests: RecordedRequest[] = [];
  let address: AddressInfo | undefined;

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const recorded: RecordedRequest = {
        method: incoming.method ?? "GET",
        path: incoming.url ?? "/",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const queue = routes.get(`${recorded.method} ${recorded.path}`);
      const next = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      const answer =
        next === undefined
          ? { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "mock404" } }
          : typeof next === "function"
            ? next(recorded)
            : next;
      outgoing.writeHead(answer.status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(answer.body));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = server.address() as AddressInfo;
  });
  afterEach(() => {
    routes.clear();
    requests.length = 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  return {
    baseUrl: () => {
      if (!address) {
        throw new Error("the mock PayPal is not listening yet");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    requests,
    on: (route, ...answers) => {
      routes.set(route, [...answers]);
    },
  };
}
