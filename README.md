# pawhold

Hold-then-capture estimates for independent vet practices, on PayPal: the practice sends an estimate, the owner authorises a PayPal hold, the practice captures on completion and re-authorises or voids when the plan changes, and an AI drafts the estimate from the clinical notes and explains every change in the owner's words.
Sandbox only: no real money moves.

## About the entry

The entry for the PayPal AI Hackathon (deadline 12 November 2026, 12:00 PST). Picked by the owner on 12 October 2026 from the ideas
drafted in the `paypal-ai-hack` repository (Idea 4, Go-Ahead in
`docs/research/ideas-2026-10-11.md`; the research in
`docs/research/hackathon-2026-10-11.md` there). Aimed at Most Impactful, Bryntum as the sponsor prize.

Status: units U1 (the skeleton: the app, the schema, the PayPal client, the webhook listener and the audit trail) and U2 (the price list, estimate versions and the CMA Order's update trigger, with a fictional practice seeded for each judge) of `docs/plans/pawhold-plan-2026-10-12.md` are built.

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

## Where things go

Research in `docs/research/<slug>.md`, briefs in `docs/research/briefs/`,
plans in `docs/plans/`, progress reports in `docs/plans/progress/`.
Runbooks in `docs/runbooks/`.

## Licence

Apache-2.0, see `LICENSE`.
