import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, ButtonLink } from "../../app/components/Button";

describe("Button", () => {
  it("is a button that never submits by accident", () => {
    const html = renderToStaticMarkup(<Button>Draft estimate</Button>);

    expect(html).toMatch(/^<button type="button"[^>]*>Draft estimate<\/button>$/);
  });

  it("submits only when asked to", () => {
    expect(renderToStaticMarkup(<Button type="submit">Send</Button>)).toContain('type="submit"');
  });

  it("carries its variant, primary by default", () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('data-variant="primary"');
    expect(renderToStaticMarkup(<Button variant="danger">Withdraw</Button>)).toContain(
      'data-variant="danger"',
    );
  });

  it("is disabled and busy while its action is pending", () => {
    const html = renderToStaticMarkup(<Button pending>Sending</Button>);

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  it("is a link when it goes somewhere", () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/today" variant="secondary">
        Today
      </ButtonLink>,
    );

    expect(html).toMatch(/^<a [^>]*href="\/today"[^>]*>Today<\/a>$/);
    expect(html).toContain('data-variant="secondary"');
  });
});
