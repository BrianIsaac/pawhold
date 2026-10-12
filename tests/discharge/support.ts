import type { Database } from "@/db/client";
import type { DischargeView } from "@/discharge/bill";
import {
  type EstimateLineInput,
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
} from "@/estimate/version";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";

import { DENTAL_LINES, type MoneyFixture } from "../support/money";
import type { PayPalDouble } from "../support/paypal-double";

/**
 * Sends a version of the case's estimate and has the owner authorise its
 * hold through U3's own functions against the double.
 *
 * @param deps - The database and the double.
 * @param deps.db - The database.
 * @param deps.paypal - The double.
 * @param fixture - The practice and the case.
 * @param lines - The version's lines.
 * @returns The version as sent.
 */
export async function heldVersion(
  deps: { db: Database["db"]; paypal: PayPalDouble },
  fixture: MoneyFixture,
  lines: readonly EstimateLineInput[] = DENTAL_LINES,
): Promise<EstimateVersionView> {
  const money = { db: deps.db, paypal: deps.paypal.client() };
  const draft = await makeEstimateVersion(deps.db, { ...fixture, actor: "vet", lines: [...lines] });
  await sendEstimate(deps.db, {
    practiceId: fixture.practiceId,
    versionId: draft.id,
    actor: "vet",
  });
  const { hold } = await orderHold(money, { ...fixture, versionId: draft.id });
  deps.paypal.approve(hold.paypalOrderId);
  await authoriseHold(money, { ...fixture, holdId: hold.id });
  return (await loadEstimateVersion(deps.db, fixture.practiceId, draft.id))!;
}

/**
 * The bill's quantities as the page first shows them: each line at its
 * estimate's low.
 *
 * @param view - The discharge page's view.
 * @returns The quantities typed, by estimate line id.
 */
export function quantitiesOf(view: DischargeView): Record<string, string> {
  return Object.fromEntries(
    view.groups.flatMap((group) =>
      group.lines.map((line) => [line.estimateLineId, String(line.quantityLow)]),
    ),
  );
}
