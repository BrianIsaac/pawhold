import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatAsleep } from "../../app/components/Drawing";
import { List, ListRow } from "../../app/components/List";

describe("List", () => {
  it("is a labelled list whose rows name each cell's column", () => {
    const html = renderToStaticMarkup(
      <List label="Today's cases" columns={["Patient", "Money"]}>
        <ListRow
          cells={[
            { column: "Patient", content: "Biscuit" },
            { column: "Money", content: "Held" },
          ]}
        />
      </List>,
    );

    expect(html).toContain('<ul aria-label="Today&#x27;s cases"');
    expect(html).toMatch(/<li[^>]*>.*Patient.*Biscuit.*Money.*Held.*<\/li>/);
  });

  it("shows its column headings once, hidden from assistive technology since each cell names its own", () => {
    const html = renderToStaticMarkup(
      <List label="Cases" columns={["Patient", "Owner"]}>
        {null}
      </List>,
    );

    expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*>.*Patient.*Owner.*<\/div>/);
  });

  it("says so when there is nothing in it", () => {
    const html = renderToStaticMarkup(
      <List label="Cases" columns={["Patient"]} empty="No cases yet.">
        {[]}
      </List>,
    );

    expect(html).toContain("No cases yet.");
    expect(html).not.toContain("<ul");
  });

  it("draws its figure above the words when it has one, still without a list", () => {
    const html = renderToStaticMarkup(
      <List label="Cases" columns={["Patient"]} empty="No cases yet." emptyFigure={<CatAsleep />}>
        {[]}
      </List>,
    );

    expect(html).toMatch(
      /<svg [^>]*aria-label="A line drawing of a cat, asleep"[\s\S]*No cases yet\./,
    );
    expect(html).not.toContain("<ul");
  });
});
