"use client";

import { useEffect, useRef, useState } from "react";

import type { BillGroup, BillReview } from "@/discharge/bill";
import { money } from "@/discharge/wording";
import type { CurrencyCode } from "@/money/currency";

import { Button } from "../../../../components/Button";
import { type SelectGroup, SelectField, TextField } from "../../../../components/Field";
import caseStyles from "../case.module.css";
import type { BillInput, ReviewAnswer } from "./actions";
import styles from "./discharge.module.css";

/** How long typing must pause before the bill is reviewed again. */
const REVIEW_PAUSE_MS = 250;

/**
 * The itemised bill being made (section 6): each approved line with the
 * quantity done, its price and its total; work no approved estimate covers,
 * noted and refused; the totals; and why the bill cannot be confirmed yet.
 * Every change is reviewed by the server, which alone prices and judges it.
 *
 * @param props - The case, its currency, the approved lines, the price list's other items, the first review and the review action.
 * @param props.caseId - The case.
 * @param props.currency - The case's currency.
 * @param props.groups - The approved lines, by the version that approved them.
 * @param props.unlisted - The price list's items not on the bill, as option groups.
 * @param props.initial - The review of the bill as it starts.
 * @param props.review - The review action, bound to the case.
 * @returns The bill.
 */
export function BillForm({
  caseId,
  currency,
  groups,
  unlisted,
  initial,
  review,
}: {
  caseId: string;
  currency: CurrencyCode;
  groups: readonly BillGroup[];
  unlisted: readonly SelectGroup[];
  initial: BillReview;
  review: (caseId: string, input: BillInput) => Promise<ReviewAnswer>;
}) {
  const [input, setInput] = useState<BillInput>(() => ({
    quantities: Object.fromEntries(
      groups.flatMap((group) =>
        group.lines.map((line) => [line.estimateLineId, String(line.quantityLow)]),
      ),
    ),
    extras: [],
  }));
  const [answer, setAnswer] = useState<BillReview>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const asked = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const ask = ++asked.current;
    setPending(true);
    const timer = setTimeout(() => {
      void review(caseId, input).then(
        (reply) => {
          if (ask !== asked.current) {
            return;
          }
          setPending(false);
          if (reply.review) {
            setAnswer(reply.review);
            setMessage(null);
          } else {
            setMessage(reply.message);
          }
        },
        () => {
          if (ask === asked.current) {
            setPending(false);
            setMessage("The bill couldn't be checked. Check your connection and try again.");
          }
        },
      );
    }, REVIEW_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [caseId, input, review]);

  const reviewed = new Map(answer.lines.map((line) => [line.estimateLineId, line]));
  const setQuantity = (lineId: string, quantity: string) =>
    setInput((before) => ({ ...before, quantities: { ...before.quantities, [lineId]: quantity } }));

  return (
    <div className={styles.bill}>
      {groups.map((group) => (
        <section
          key={group.versionNumber}
          className={caseStyles.panel}
          aria-labelledby={`bill-group-${group.versionNumber}`}
        >
          <h2 id={`bill-group-${group.versionNumber}`} className={caseStyles.panelTitle}>
            {group.heading}
          </h2>
          <ul className={styles.lines}>
            {group.lines.map((line) => {
              const done = reviewed.get(line.estimateLineId);
              const fieldId = `done-${line.estimateLineId}`;
              return (
                <li key={line.estimateLineId} className={styles.line}>
                  <div className={styles.lineWhat}>
                    <p className={caseStyles.lineName}>
                      {line.name}
                      <span className={caseStyles.code}>{line.code}</span>
                    </p>
                    {line.ownerWording === null ? null : (
                      <p className={styles.lineNote}>
                        The owner read: &quot;{line.ownerWording}&quot;
                      </p>
                    )}
                    {line.dependsOn === null ? null : (
                      <p className={styles.lineNote}>Only if: {line.dependsOn}</p>
                    )}
                  </div>
                  <div className={styles.lineDone}>
                    <TextField
                      id={fieldId}
                      name={fieldId}
                      label={
                        <>
                          <span aria-hidden="true">Done</span>
                          <span className="visually-hidden">Done: {line.name}</span>
                        </>
                      }
                      inputMode="numeric"
                      autoComplete="off"
                      value={input.quantities[line.estimateLineId] ?? ""}
                      onChange={(event) => setQuantity(line.estimateLineId, event.target.value)}
                      hint={
                        line.quantityLow === line.quantityHigh
                          ? `Approved: ${line.quantityHigh}`
                          : `Approved: ${line.quantityLow} to ${line.quantityHigh}`
                      }
                      {...(done?.issue ? { error: done.issue } : {})}
                    />
                  </div>
                  <p className={styles.linePrice}>
                    <span className={styles.unitPrice}>
                      {money(line.unitPricePence, currency)} per {line.unit}
                    </span>
                    <span className={styles.lineTotal}>
                      {money(done?.amountPence ?? 0, currency)}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <ExtraWork
        currency={currency}
        unlisted={unlisted}
        extras={answer.extras}
        noted={input.extras}
        onChange={(extras) => setInput((before) => ({ ...before, extras }))}
      />

      <section className={caseStyles.panel} aria-labelledby="bill-total-title" aria-busy={pending}>
        <h2 id="bill-total-title" className={caseStyles.panelTitle}>
          Total
        </h2>
        <dl className={styles.totals}>
          <div>
            <dt>Bill</dt>
            <dd>{money(answer.billedPence, currency)}</dd>
          </div>
          <div>
            <dt>Held</dt>
            <dd>{money(answer.heldPence, currency)}</dd>
          </div>
        </dl>
        <div aria-live="polite" className={styles.verdict}>
          {message ? (
            <p role="alert" className={caseStyles.notice}>
              {message}
            </p>
          ) : answer.verdict.kind === "refused" ? (
            <p className={caseStyles.notice}>{answer.verdict.reason}</p>
          ) : (
            <>
              <p className={styles.sentence}>{answer.verdict.sentence}</p>
              {answer.verdict.blocked ? (
                <p className={caseStyles.notice}>{answer.verdict.blocked}</p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Work done that no approved estimate covers: the vet notes it on the bill,
 * where it is refused with section 6's sentence and never charged.
 *
 * @param props - The currency, the price list's other items, the work as reviewed and as noted, and the change.
 * @param props.currency - The case's currency.
 * @param props.unlisted - The price list's items not on the bill.
 * @param props.extras - The noted work, as the server reviewed it.
 * @param props.noted - The noted work, as typed.
 * @param props.onChange - Takes the noted work after a change.
 * @returns The section.
 */
function ExtraWork({
  currency,
  unlisted,
  extras,
  noted,
  onChange,
}: {
  currency: CurrencyCode;
  unlisted: readonly SelectGroup[];
  extras: BillReview["extras"];
  noted: BillInput["extras"];
  onChange: (extras: BillInput["extras"]) => void;
}) {
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [fault, setFault] = useState<string | null>(null);
  const reviewed = new Map(extras.map((extra) => [extra.code, extra]));
  const names = new Map(
    unlisted.flatMap((group) => group.options).map((option) => [option.value, option.label]),
  );
  const offered = unlisted
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => !noted.some((one) => one.code === option.value)),
    }))
    .filter((group) => group.options.length > 0);

  return (
    <section className={caseStyles.panel} aria-labelledby="extra-work-title">
      <h2 id="extra-work-title" className={caseStyles.panelTitle}>
        Work not on an approved estimate
      </h2>
      <p className={caseStyles.muted}>
        Note work done that no approved estimate covers. It is kept with the bill and never charged.
      </p>
      {noted.length > 0 ? (
        <ul className={styles.lines}>
          {noted.map((one) => {
            const extra = reviewed.get(one.code);
            return (
              <li key={one.code} className={styles.line}>
                <div className={styles.lineWhat}>
                  <p className={caseStyles.lineName}>
                    {extra?.name ?? names.get(one.code) ?? one.code}
                    <span className={caseStyles.code}>{one.code}</span>
                  </p>
                  <p className={styles.refused}>{extra?.issue ?? ""}</p>
                </div>
                <p className={styles.lineDone}>Done: {one.quantity}</p>
                <div className={styles.linePrice}>
                  <span className={styles.unitPrice}>
                    <s className={styles.notCharged}>{money(extra?.amountPence ?? 0, currency)}</s>{" "}
                    not charged
                  </span>
                  <Button
                    variant="quiet"
                    onClick={() => onChange(noted.filter((other) => other.code !== one.code))}
                  >
                    Remove<span className="visually-hidden"> {extra?.name ?? one.code}</span>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {offered.length > 0 ? (
        <div className={styles.extraForm}>
          <SelectField
            id="extra-code"
            name="extraCode"
            label="Item"
            placeholder="Choose an item"
            groups={offered}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            {...(fault ? { error: fault } : {})}
          />
          <TextField
            id="extra-quantity"
            name="extraQuantity"
            label="Quantity"
            inputMode="numeric"
            autoComplete="off"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <div className={styles.extraAction}>
            <Button
              variant="secondary"
              onClick={() => {
                if (code === "") {
                  setFault("Choose an item first");
                  return;
                }
                setFault(null);
                onChange([...noted, { code, quantity }]);
                setCode("");
                setQuantity("1");
              }}
            >
              Note the work
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
