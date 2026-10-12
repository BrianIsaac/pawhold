import postgres from "postgres";
import { z } from "zod";

import type { StoredDelivery, WebhookStore } from "./p8-webhooks";

const row = z.looseObject({
  event_id: z.string(),
  event_type: z.string(),
  resource_id: z.string().nullable(),
  verification: z.string(),
  is_mock: z.boolean(),
  received_at: z.date(),
  raw_body: z.string(),
  transmission_id: z.string(),
  transmission_time: z.string(),
  cert_url: z.string().nullable(),
  auth_algo: z.string(),
  transmission_sig: z.string().nullable().optional(),
});

/**
 * Reads the listener's `webhook_event` rows from its database, read only.
 *
 * @param url - The database's connection URL; never logged.
 * @returns The store.
 */
export function postgresWebhookStore(url: string): WebhookStore {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "pawhold-probes", default_transaction_read_only: true },
  });
  return {
    keepsSignatures: async () => {
      const found = await sql`
        select 1 from information_schema.columns
        where table_name = 'webhook_event' and column_name = 'transmission_sig'`;
      return found.length > 0;
    },
    find: async (resourceIds) => {
      const rows =
        await sql`select * from webhook_event where resource_id = any(${resourceIds as string[]})`;
      return rows.map((r): StoredDelivery => {
        const d = row.parse(r);
        return {
          eventId: d.event_id,
          eventType: d.event_type,
          resourceId: d.resource_id,
          verification: d.verification,
          isMock: d.is_mock,
          receivedAt: d.received_at.toISOString(),
          rawBody: d.raw_body,
          transmissionId: d.transmission_id,
          transmissionTime: d.transmission_time,
          certUrl: d.cert_url,
          authAlgo: d.auth_algo,
          transmissionSig: d.transmission_sig ?? null,
        };
      });
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
