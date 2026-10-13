import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CheckboxField,
  FileField,
  SelectField,
  TextAreaField,
  TextField,
} from "../../app/components/Field";

describe("the fields", () => {
  it("labels a text area by its id, with section 6's placeholder", () => {
    const html = renderToStaticMarkup(
      <TextAreaField
        name="notes"
        label="Clinical notes"
        placeholder="Type or paste your notes, as you would write them."
      />,
    );

    expect(html).toContain('<label for="field-notes"');
    expect(html).toContain(">Clinical notes</label>");
    expect(html).toMatch(/<textarea[^>]*name="notes"/);
    expect(html).toMatch(/<textarea[^>]*id="field-notes"/);
    expect(html).toContain('placeholder="Type or paste your notes, as you would write them."');
  });

  it("ties its hint and its error to the control and marks it invalid", () => {
    const html = renderToStaticMarkup(
      <TextField
        name="quantityHigh"
        label="Most"
        hint="Whole units"
        error="Must be at least 1"
        inputMode="numeric"
      />,
    );

    expect(html).toContain('aria-describedby="field-quantityHigh-hint field-quantityHigh-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="field-quantityHigh-error"');
    expect(html).toContain("Must be at least 1");
  });

  it("is neither described nor invalid when it has no hint or error", () => {
    const html = renderToStaticMarkup(<TextField name="patient" label="Patient" />);

    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("aria-invalid");
  });

  it("takes its id when one is given, so two forms on a page never share one", () => {
    const html = renderToStaticMarkup(
      <TextField id="line-2-low" name="quantityLow" label="Least" />,
    );

    expect(html).toContain('<label for="line-2-low"');
    expect(html).toContain('id="line-2-low"');
  });

  it("groups a select's options", () => {
    const html = renderToStaticMarkup(
      <SelectField
        name="code"
        label="Item"
        groups={[
          {
            label: "Procedure",
            options: [{ value: "DEN-SP", label: "Dental scale and polish" }],
          },
        ]}
      />,
    );

    expect(html).toContain('<optgroup label="Procedure">');
    expect(html).toContain('<option value="DEN-SP">Dental scale and polish</option>');
  });

  it("lists a short select's options without groups, after its empty first option (U17)", () => {
    const html = renderToStaticMarkup(
      <SelectField
        name="species"
        label="Species"
        placeholder="Choose the species"
        options={[
          { value: "dog", label: "Dog" },
          { value: "cat", label: "Cat" },
        ]}
      />,
    );

    expect(html).not.toContain("<optgroup");
    expect(html).toContain(
      '<option value="">Choose the species</option><option value="dog">Dog</option><option value="cat">Cat</option>',
    );
  });

  it("puts a checkbox before its label, the label wide enough to tap", () => {
    const html = renderToStaticMarkup(
      <CheckboxField name="sharePhoto" label="Show the photo to the owner" />,
    );

    expect(html).toMatch(/<input type="checkbox"[^>]*id="field-sharePhoto"/);
    expect(html).toContain(">Show the photo to the owner</span></label>");
  });

  it("takes only the image types an update's photo may be", () => {
    const html = renderToStaticMarkup(<FileField name="photo" label="Add a photo" />);

    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).toContain('type="file"');
  });
});
