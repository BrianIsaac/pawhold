import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "../../app/page";

describe("the landing page", () => {
  it("carries the heading and the line section 6 drafts for judge mode", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toMatch(/<h1[^>]*>Estimates your clients can say yes to\.<\/h1>/);
    expect(html).toContain(
      "pawhold turns a vet&#x27;s notes into an itemised estimate, holds it on the owner&#x27;s PayPal or card, asks before anything extra, and charges exactly the bill. Sandbox only: no real money moves.",
    );
  });

  it("opens the two doors as plain links, which work without JavaScript", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toMatch(/<a [^>]*href="\/try\/practice"[^>]*>Try it as the practice<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/try\/owner"[^>]*>Try it as the owner<\/a>/);
    expect(html).not.toContain("<script");
  });

  it("says under the doors what a judge gets and where the PayPal login is", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain(
      "You&#x27;ll get your own practice with cases at every stage. The PayPal sandbox login is on the owner&#x27;s page.",
    );
  });
});
