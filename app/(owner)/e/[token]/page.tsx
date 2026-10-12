import type { Metadata } from "next";

import { formatPence } from "@/money/format";
import { resolveOwnerLink } from "@/owner/resolve";
import { ownerPage } from "@/owner/view";
import { authoriseLabel, authorisingUnavailable } from "@/owner/wording";
import { database, paypalBrowserClientId, sessionSecret } from "@/server/runtime";

import { AskThePractice } from "./ask-the-practice";
import { Authorise } from "./authorise";
import { Estimate } from "./estimate";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your pet's estimate" };

/**
 * The page an owner's link opens: the estimate to authorise, an update to
 * answer, or the receipt, for the case and the version the link names; the
 * "ask the practice" page when the link has expired or was changed.
 *
 * @param props - The route's parameters.
 * @param props.params - The link's token.
 * @returns The page.
 */
export default async function OwnerLinkPage({ params }: PageProps<"/e/[token]">) {
  const { token } = await params;
  const { db } = database();
  const resolved = await resolveOwnerLink(db, token, {
    secret: sessionSecret(),
    now: new Date(),
  });
  if (resolved.kind === "ask_the_practice") {
    return <AskThePractice practiceName={resolved.practiceName} />;
  }
  const page = await ownerPage(db, resolved);
  if (!page) {
    return <AskThePractice practiceName={null} />;
  }
  const clientId = paypalBrowserClientId();
  const amount = formatPence(page.holdPence, page.currency);
  const awaiting = page.state === "awaiting_owner" || page.hold?.status === "authorised";
  return (
    <Estimate
      page={page}
      authorise={
        !awaiting ? null : clientId ? (
          <Authorise
            clientId={clientId}
            token={token}
            currency={page.currency}
            amount={amount}
            cardLabel={authoriseLabel(amount)}
            hold={
              page.hold
                ? {
                    status: page.hold.status,
                    paymentKind: page.hold.paymentKind,
                    amountPence: page.hold.amount.pence,
                    confirmedAt: page.hold.confirmedAt?.toISOString() ?? null,
                  }
                : null
            }
          />
        ) : (
          <p className={styles.unavailable} role="alert">
            {authorisingUnavailable(page.header.practiceName)}
          </p>
        )
      }
    />
  );
}
