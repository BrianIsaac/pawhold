import type { Metadata } from "next";

import { formatPence } from "@/money/format";
import { resolveOwnerLink } from "@/owner/resolve";
import { ownerPage } from "@/owner/view";
import {
  approveLabel,
  authoriseLabel,
  authorisingUnavailable,
  linkReplaced,
  REPLACED_HEADING,
  updateDeclined,
} from "@/owner/wording";
import { database, paypalBrowserClientId, sessionSecret } from "@/server/runtime";

import { AskThePractice, Notice } from "./ask-the-practice";
import { Authorise } from "./authorise";
import { Decline } from "./decline";
import { Estimate } from "./estimate";
import { HeldStatus } from "./held";
import styles from "./page.module.css";
import { Update } from "./update";

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

  const held = page.hold?.status === "authorised";
  const awaiting =
    page.isLatest &&
    page.state === (page.kind === "estimate" ? "awaiting_owner" : "update_awaiting_owner");
  if (!held && !awaiting && !page.isLatest) {
    return <Notice heading={REPLACED_HEADING} text={linkReplaced(page.header.practiceName)} />;
  }

  const money = (pence: number) => formatPence(pence, page.currency);
  const authorise = (amount: string, cardLabel: string) => {
    if (page.hold?.status === "authorised" && page.hold.paymentKind) {
      return (
        <HeldStatus
          token={token}
          amount={amount}
          hold={{
            status: page.hold.status,
            paymentKind: page.hold.paymentKind,
            amountPence: page.hold.amount.pence,
            confirmedAt: page.hold.confirmedAt?.toISOString() ?? null,
          }}
        />
      );
    }
    const clientId = paypalBrowserClientId();
    return clientId ? (
      <Authorise
        clientId={clientId}
        token={token}
        currency={page.currency}
        amount={amount}
        cardLabel={cardLabel}
      />
    ) : (
      <p className={styles.unavailable} role="alert">
        {authorisingUnavailable(page.header.practiceName)}
      </p>
    );
  };

  if (page.kind === "estimate") {
    const amount = money(page.holdPence);
    return (
      <Estimate
        page={page}
        authorise={held || awaiting ? authorise(amount, authoriseLabel(amount)) : null}
      />
    );
  }

  const delta = money(page.increasePence);
  const declined = page.isLatest && page.state === "update_declined";
  return (
    <Update
      page={page}
      answer={
        held ? (
          authorise(delta, approveLabel(delta))
        ) : awaiting ? (
          <>
            {authorise(delta, approveLabel(delta))}
            <Decline token={token} />
          </>
        ) : declined ? (
          <p className={styles.declined} role="status">
            {updateDeclined(money(page.heldPence))}
          </p>
        ) : null
      }
    />
  );
}
