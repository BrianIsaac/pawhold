import { EstimateError } from "@/estimate/version";
import { MoneyError } from "@/money/errors";

import { PracticeError } from "./errors";

/**
 * A refusal from U2, U3 or this unit in words the vet reads on the case
 * page. These are this unit's words (section 6 drafts none of them, D11).
 *
 * @param error - What was thrown.
 * @returns The sentence, or null when the error is not a refusal (it is then rethrown).
 */
export function refusalMessage(error: unknown): string | null {
  if (error instanceof PracticeError) {
    return error.message;
  }
  if (error instanceof EstimateError) {
    switch (error.reason) {
      case "empty":
        return "Add at least one item before sending.";
      case "price_list_changed":
        return "Your price list changed since this draft. Change any line to reprice it, then send.";
      case "sent":
        return "This estimate was sent already. The page shows it as it is now.";
      case "draft_exists":
        return "A draft is open already. The page shows it as it is now.";
      case "no_price_list":
        return "The practice has no price list to price from.";
      case "lines_refused":
        return `A line was refused: ${error.issues.map((issue) => issue.message).join("; ")}.`;
      default:
        return "That didn't work. The page shows the estimate as it is now.";
    }
  }
  if (error instanceof MoneyError) {
    switch (error.reason) {
      case "no_increase":
        return "This update adds nothing over what is held, so there is nothing for the owner to approve.";
      case "wrong_state":
      case "version_not_awaiting":
        return "The case moved on since the page was opened. It shows as it is now.";
      default:
        return "That didn't work. The page shows the case as it is now.";
    }
  }
  return null;
}
