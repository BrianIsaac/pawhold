import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dialog } from "../../app/components/Dialog";

describe("Dialog", () => {
  it("renders its trigger and a closed modal titled by its heading", () => {
    const html = renderToStaticMarkup(
      <Dialog id="send" trigger="Send to Ann" title="Send the estimate to Ann?">
        <p>Body</p>
      </Dialog>,
    );

    expect(html).toMatch(
      /<button type="button"[^>]*aria-haspopup="dialog"[^>]*>Send to Ann<\/button>/,
    );
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="send-title"/);
    expect(html).not.toMatch(/<dialog[^>]* open/);
    expect(html).toContain('<h2 id="send-title"');
    expect(html).toContain("<p>Body</p>");
  });

  it("gives its close button a name a screen reader can read", () => {
    const html = renderToStaticMarkup(
      <Dialog id="x" trigger="Open" title="Title">
        {null}
      </Dialog>,
    );

    expect(html).toContain(">Cancel</button>");
  });
});
