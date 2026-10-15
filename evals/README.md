# The estimate agent's eval

Plan 3.4, "Evaluation": about thirty note sets written for the fictional
practice (D2), each with the codes a vet would expect; the bar is no invented
code and no invented span, ever (a hard fail); code recall and precision are
reported with the date graded; the owner's wording is checked for amounts and
doses.

## A note set

`notes/NN-slug.json`:

- `notes`: the vet's notes as typed, in clinical shorthand.
- `expected`: each item a vet would expect on the estimate; an inner list is
  alternatives, any one of which finds the item (an extraction simple or
  surgical, antibiotics by injection or tablets).
- `acceptable`: codes a vet would accept without expecting them (the
  anaesthetic inside a priced procedure, a clip and scrub); they do not count
  against precision.
- `unmatched`: phrases of the notes no item on the list covers; reported, not
  graded.

The ground truth was written before any model answered and is not changed to
fit an answer.

## Grading

- **Hard bar**, from the answer as the model gave it: every line's code must
  be on the list, and every span (a line's or an unmatched one) must be found
  in the notes by the agent's own `findSpan`. Met only when every set was
  answered.
- **Recall**: expected items found by the lines the guardrails keep, over all
  expected items. **Precision**: distinct kept codes that are expected or
  acceptable, over all distinct kept codes. Both summed over every set.
- **Owner's wording**: kept lines whose wording fell back to the item's name.

## Running it

```sh
pnpm eval                       # replay evals/recorded/ (CI runs this through tests/evals/)
pnpm eval --require-all         # also fail when a set has no recording
env $(grep '^OPENAI_API_KEY=' .env.local) pnpm eval --live --require-all --write-results
pnpm eval --only=01-dental-plan-example
```

A request's hash covers the model, the effort, the prompt's version and text,
the price list and the notes, so a changed prompt or list asks again; a
recorded answer is never asked twice.

## The live run of 12 October 2026

`gpt-6.1-sol`, effort `medium`, prompt `draft.v1`, 30 sets, one call each:
hard bar met (0 invented codes, 0 invented spans), recall 0.960 (119 of 124),
precision 0.966 (141 of 146), no owner's wording fell back, 9 of 9 unlisted
phrases named. `results.json` holds every set's grade.

The misses, read from the recorded answers:

- Antibiotics and pain relief written without a route ("Abs + pain
  relief", "abs") were put in `unmatched` rather than guessed as an injection
  or tablets (sets 12, 14): three of the five missed items.
- "BG curve" was put in `unmatched` though `LAB-BG` (blood glucose, per test)
  is on the list (set 10).
- "bandage" became `CONS-DRESS` (a surgical dressing) rather than
  `PROC-BAND` (set 09).
- Four of the five codes not expected are a buster collar added after
  abdominal or other surgery (sets 05, 06, 08, 14), which the prompt's own
  example ("the collar after a named surgery that needs one") invites; the
  fifth is `HOSP-NIGHT` beside `HOSP-ICU` for one ICU night (set 25), which
  would bill the night twice. The vet's review is the guard for both.
