# pawhold

Hold-then-capture estimates for independent vet practices, on PayPal: the practice sends an estimate, the owner authorises a PayPal hold, the practice captures on completion and re-authorises or voids when the plan changes, and an AI drafts the estimate from the clinical notes and explains every change in the owner's words.
Sandbox only: no real money moves.

## About the entry

The entry for the PayPal AI Hackathon (deadline 12 November 2026, 12:00 PST). Picked by the owner on 12 October 2026 from the ideas
drafted in the `paypal-ai-hack` repository (Idea 4, Go-Ahead in
`docs/research/ideas-2026-10-11.md`; the research in
`docs/research/hackathon-2026-10-11.md` there). Aimed at Most Impactful, Bryntum as the sponsor prize.

Status: units U1 (the skeleton: the app, the schema, the PayPal client, the webhook listener and the audit trail) U2 (the price list, estimate versions and the CMA Order's update trigger, with a fictional practice seeded for each judge) and U4 (the estimate agent: notes to a priced draft and the vet's finding to an update, under code guardrails, with its eval) of `docs/plans/pawhold-plan-2026-10-12.md` are built.

## Develop

Needs Node 22.12 or later, pnpm (the version in `package.json`, through `corepack enable`) and Docker.

```sh
pnpm install
docker compose up -d --wait db   # Postgres for development and the tests (compose.yml)
DATABASE_URL=postgres://pawhold:pawhold@127.0.0.1:54329/pawhold pnpm db:migrate
pnpm dev
```

The gate, run before every commit and in CI:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The tests start the Docker database if it is not running, and each run migrates a fresh database of its own and drops it at the end.

## The estimate agent's evaluation

The agent drafts estimate lines from a vet's notes with OpenAI's `gpt-6.1-sol` (reasoning effort `medium`) under a strict JSON schema with no price field; code checks every line (a code must be on the practice's list, a quoted span must be in the notes, the owner's wording may carry no money, percentage or dose) and prices it from the list. Thirty note sets written for the fictional practice (`evals/notes/`) carry the codes a vet would expect.

Graded live on 12 October 2026 (05:37 UTC) against `gpt-6.1-sol`:

| Measure                                                          | Result                      |
| ---------------------------------------------------------------- | --------------------------- |
| Hard bar: no invented code, no invented span, in any set         | met: 0 and 0 across 30 sets |
| Code recall (expected items found)                               | 0.960 (119 of 124)          |
| Code precision (codes drafted that a vet would expect or accept) | 0.966 (141 of 146)          |
| Owner's wording that had to fall back for money or a dose        | 0 lines                     |
| Phrases with no item on the list, named as unmatched             | 9 of 9                      |

The answers are recorded in `evals/recorded/`; CI replays them (`pnpm eval`), and `pnpm eval --live` asks the model again for any set whose request has changed. Details and the misses: `evals/README.md`.

## Where things go

Research in `docs/research/<slug>.md`, briefs in `docs/research/briefs/`,
plans in `docs/plans/`, progress reports in `docs/plans/progress/`.
Runbooks in `docs/runbooks/`.

## Licence

Apache-2.0, see `LICENSE`.
