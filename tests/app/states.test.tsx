import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PracticeError from "../../app/(practice)/error";
import OwnerError from "../../app/(owner)/e/[token]/error";
import NotFound from "../../app/not-found";
import {
  answeredUpdateHeading,
  DECLINE_FAILED,
  estimateWithdrawn,
  updateWithdrawn,
} from "@/owner/wording";

/*
 * The error states (U11), each worded in its screen's voice and
 * announced as a status, with a way to go on.
 */

const noop = () => undefined;

describe("a page that failed", () => {
  it("tells the practice nothing was charged and offers to try again", () => {
    const html = renderToStaticMarkup(
      <PracticeError error={Object.assign(new Error("x"), { digest: "d" })} reset={noop} />,
    );

    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
    expect(html).toContain(
      "pawhold couldn&#x27;t show this page. Nothing has been charged by it. Try again, or go back to today&#x27;s cases.",
    );
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toMatch(/<a [^>]*href="\/today"[^>]*>Today&#x27;s cases</);
  });

  it("tells the owner nothing was charged and offers to try again", () => {
    const html = renderToStaticMarkup(
      <OwnerError error={Object.assign(new Error("x"), { digest: "d" })} reset={noop} />,
    );

    expect(html).toMatch(/<h1[^>]*>This page couldn&#x27;t load<\/h1>/);
    expect(html).toContain(
      "Nothing has been charged. Try again in a moment, or ask the practice that sent you the link.",
    );
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
  });

  it("says a page that does not exist is not there, with the way back", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toMatch(/<h1[^>]*>There&#x27;s nothing here<\/h1>/);
    expect(html).toContain(
      "This page doesn&#x27;t exist, or it belongs to another visitor&#x27;s practice.",
    );
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to pawhold&#x27;s start page</);
  });
});

describe("the owner's words for a withdrawn or answered update", () => {
  it("words a withdrawn estimate and a withdrawn update", () => {
    expect(estimateWithdrawn("Hollins Lane Veterinary Surgery")).toBe(
      "Hollins Lane Veterinary Surgery withdrew this estimate, so there is nothing to authorise and nothing has been charged. Ask them if you'd like it sent again.",
    );
    expect(updateWithdrawn("Hollins Lane Veterinary Surgery")).toBe(
      "Hollins Lane Veterinary Surgery withdrew this update, so there is nothing to approve. What you authorised before stays as it was.",
    );
  });

  it("tells an answered update in the past", () => {
    expect(answeredUpdateHeading("Rowan Hale")).toBe(
      "Rowan Hale found something and asked before going ahead.",
    );
  });

  it("does not blame PayPal for a decline that did not go through", () => {
    expect(DECLINE_FAILED).toBe("That didn't go through, so nothing has changed. Try again.");
  });
});
