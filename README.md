# pawhold

Hold-then-capture estimates for independent vet practices, on PayPal: the practice sends an estimate, the owner authorises a PayPal hold, the practice captures on completion and re-authorises or voids when the plan changes, and an AI drafts the estimate from the clinical notes and explains every change in the owner's words.
Sandbox only: no real money moves.

## Try it

**<https://pawhold.onrender.com>**: no sign-up, no download, nothing to pay. Everything runs on PayPal's sandbox, so no real money moves.

The landing page has two doors:

- **Try it as the practice** opens a fictional vet practice of your own, Hollins Lane Veterinary Surgery, with fifteen cases at every stage of the money: estimates drafted and sent, holds on PayPal and on cards, updates asked for and declined, discharges captured, released and refunded.
- **Try it as the owner** opens the page a pet owner gets on their phone for an estimate waiting for them, with the PayPal sandbox login and a test card on it, so you can authorise the hold yourself.

In two minutes you will see an itemised estimate written in the owner's words, authorise it through PayPal's own sandbox window, watch the practice's list turn it to "Held", and read every step of a case on its timeline, PayPal's ids and the model's output included.

## Testing instructions

The address is **<https://pawhold.onrender.com>**. No pawhold account is needed: each visitor gets a practice of their own, which no one else sees, for seven days. Both doors open the same practice for the same browser, so you can go between the owner's side and the practice's side.

### The sandbox login and the test card

These are PayPal sandbox values, published for testing as the hackathon's rules ask. They move no real money. The owner's page shows them too.

| For                                               | Use                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| The PayPal button (a GB personal sandbox account) | Email `sb-gonzg53323603@personal.example.com`, password `A1@{*7iO`        |
| The card fields (PayPal's GB "Test Case 1" Visa)  | Card `4462 6030 4234 3024`, expiry `12/30`, security code `123`, any name |

### Two minutes as the owner

1. Open <https://pawhold.onrender.com> in a fresh browser window.
2. Click **Try it as the owner**.
3. Read **Otis's estimate from Hollins Lane Veterinary Surgery**: each line in plain words with "What the vet wrote" under it, the likely range, and **Testing in PayPal's sandbox** with the login and the test card.
4. Click the **PayPal** button and, in PayPal's window, log in with the sandbox buyer login above and approve. (Or type the test card into the card fields and click **Authorise £1,010.00**.)
5. See **Held** and "Done. £1,010.00 is held on your PayPal. You'll get the final bill at discharge."

A few seconds later the page adds "Confirmed by PayPal" and the time: PayPal's webhook has arrived.

### As the practice

1. Open <https://pawhold.onrender.com> and click **Try it as the practice**. You are in the practice the owner's door made: Otis now shows **Held £1,010.00**.
2. See today's cases: a case at every money state, from **Waiting for owner** to **Refunded £20.00** (the table below says what each means).
3. Click **Bramble**, then click **Show PayPal and model details** on a row of the timeline. Each row says who acted, what happened to the money and PayPal's ids; the rows of a case pawhold seeded say "Seeded for the demo".
4. Go to **Today's cases**, click **Otis** and then click **Discharge**: the itemised bill against what Priya authorised, with "£876.00 will be captured from the hold. £134.00 will be released to Priya."
5. Click **Confirm and charge £876.00**, then click **Confirm and charge £876.00** again in the dialog. pawhold captures £876.00 at PayPal and releases the rest: "£876.00 captured. £134.00 released to Priya."
6. Go to **Today's cases** and click **New case**, fill in a patient, its species, an owner and a procedure, and click **Open the case**. Type or paste your notes into **Clinical notes** and click **Draft estimate**: the model drafts each line from your words, priced from the practice's list, with "From your notes" under each.

Only a hold you authorised yourself can be charged: the seeded cases' holds were never PayPal's, so pawhold refuses to send them to PayPal. To try an update, open **Otis** while it is held, describe a finding under **Add an update**, send it, then click **Try it as the owner** again: the owner's door opens the newest estimate Priya has been sent. There is no phone in the demo, so a case waiting for its owner also offers **Open Priya's page**: the page the owner's link opens, in a new tab.

### What each money state means

The practice's list shows each case's money as a chip, in these words.

| Chip               | What it means                                                                                                                       | Seeded case                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Estimate draft     | The vet is writing the estimate; the owner has seen nothing                                                                         | Pip, Moss                                      |
| Waiting for owner  | The estimate is sent; nothing is held until the owner authorises it                                                                 | Otis, Archie                                   |
| Held {amount}      | PayPal holds the top of the estimate on the owner's PayPal or card; nothing is charged yet                                          | Hazel (PayPal), Willow, Biscuit, Clover (card) |
| Update waiting     | The vet found more to do and asked; the extra is not held until the owner says yes                                                  | Juno                                           |
| Update declined    | The owner said no to the extra: the work stays within what is held                                                                  | Bramble                                        |
| Hold extended      | PayPal reauthorised a PayPal-account hold after its three-day honour period                                                         | Bramble                                        |
| Honour period over | A card hold is past PayPal's three days; card holds are never reauthorised, so the practice is told to ask the owner for a new hold | Rufus                                          |
| Captured {amount}  | Discharged: exactly the bill was captured, from each hold up to its amount                                                          | Poppy                                          |
| Released {amount}  | Discharged: what the bill did not use was released back to the owner                                                                | Teddy                                          |
| Refunded {amount}  | Part of a captured bill was refunded after discharge, as goodwill or a correction                                                   | Luna                                           |
| Withdrawn          | The practice withdrew an estimate before the owner authorised it; PayPal's order was left unapproved                                | Milo                                           |

### What is seeded and what is live

- **Seeded**: every case's history before you arrive. Its timeline rows say "Seeded for the demo", its PayPal ids begin `SEEDED` and are never sent to PayPal, and its holds cannot be charged.
- **Live**: everything you do. Authorising Otis makes a real order and authorisation in PayPal's sandbox; a discharge captures and voids there; PayPal's webhooks confirm each step on the page. Drafting an estimate or an update asks OpenAI's `gpt-6.1-sol`, and code checks every line it drafts before it is shown (no invented item, no invented quote from the notes, no money in the owner's words).

### What runs on its own

An hourly job, on Render's cron:

- **Reauthorises** a PayPal-account hold once, between day 4 and day 29, so it stays good for a long stay; flags a **card** hold whose honour period is over ("Honour period over"); and flags a seeded PayPal hold the same way after three days, since a seeded hold is never sent to PayPal.
- **Resumes** a discharge stopped part way, and reconciles PayPal's webhooks.
- **Prunes** a judge's session seven days after it started: any hold still standing is voided at PayPal first, and the practice's records are kept. A new visit makes a new practice.

### The draft cap and the model

Each practice can ask the model for 40 drafts an hour; a press of **Draft estimate** with identical notes is answered from the practice's cache and not counted. Past the cap the vet still gets an empty estimate to fill from the price list, and every other part keeps working. The model is OpenAI's `gpt-6.1-sol`, called from pawhold's server; you need no key.

## About the entry

The entry for the PayPal AI Hackathon (deadline 12 November 2026, 12:00 PST). Picked by the owner on 12 October 2026 from the ideas
drafted in the `paypal-ai-hack` repository (Idea 4, Go-Ahead in
`docs/research/ideas-2026-10-11.md`; the research in
`docs/research/hackathon-2026-10-11.md` there). Aimed at Most Impactful, Bryntum as the sponsor prize.

Status: built so far are the skeleton (the app, the schema, the PayPal client, the webhook listener and the audit trail), the price list and estimate versions with the CMA Order's update trigger, the money lifecycle (holds, updates, reauthorisation, discharge, refunds), the estimate agent with its evaluation, the practice's screens, the owner's phone pages, the schedule agent's day, and judge mode.

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
pnpm lint && pnpm typecheck && pnpm test && pnpm test:browser && pnpm build
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
