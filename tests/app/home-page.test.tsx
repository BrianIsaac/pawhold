import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "../../app/page";

describe("the landing page", () => {
  it("carries the heading section 6 drafts for judge mode", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("<h1>Estimates your clients can say yes to.</h1>");
    expect(html).toContain("Sandbox only: no real money moves.");
  });
});
