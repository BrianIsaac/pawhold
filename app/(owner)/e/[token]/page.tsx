import type { Metadata } from "next";

import { resolveOwnerLink } from "@/owner/resolve";
import { ownerCaseHeader } from "@/owner/view";
import { estimateHeading } from "@/owner/wording";
import { database, sessionSecret } from "@/server/runtime";

import { AskThePractice } from "./ask-the-practice";

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
  const header = await ownerCaseHeader(db, resolved.practiceId, resolved.caseId);
  if (!header) {
    return <AskThePractice practiceName={null} />;
  }
  return <h1>{estimateHeading(header.patientName, header.practiceName)}</h1>;
}
