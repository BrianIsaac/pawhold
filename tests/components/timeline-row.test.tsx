import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimelineRow } from "../../app/components/TimelineRow";

describe("TimelineRow", () => {
  it("reads as section 6's one line: time, who, what", () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        at="2026-10-12T13:02:00.000Z"
        time="14:02"
        who="Owner"
        what="authorised a hold of £640.00 (PayPal, confirmed 14:02:11)"
        details={[]}
      />,
    );

    expect(html).toMatch(/<time dateTime="2026-10-12T13:02:00.000Z"[^>]*>14:02<\/time>/);
    expect(html).toContain("Owner: authorised a hold of £640.00 (PayPal, confirmed 14:02:11)");
  });

  it("keeps the raw event behind section 6's disclosure", () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        at="2026-10-12T13:02:00.000Z"
        time="14:02"
        who="Owner"
        what="authorised a hold"
        details={[
          { term: "PayPal order", value: "5O190127TN364715T" },
          { term: "Action", value: "hold.authorised" },
        ]}
      />,
    );

    expect(html).toContain("<summary");
    expect(html).toContain("Show PayPal and model details");
    expect(html).toMatch(/<dt[^>]*>PayPal order<\/dt><dd[^>]*>5O190127TN364715T<\/dd>/);
  });

  it("names a seeded event as seeded (D16)", () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        at="2026-10-12T13:02:00.000Z"
        time="14:02"
        who="System"
        what="extended the hold"
        details={[]}
        note="Seeded for the demo"
      />,
    );

    expect(html).toContain("Seeded for the demo");
  });
});
