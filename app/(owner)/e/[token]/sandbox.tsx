import { groupedCardNumber, SANDBOX_TEST_CARD, type SandboxBuyerLogin } from "@/owner/sandbox";

import styles from "./page.module.css";

/**
 * What a judge needs to authorise in PayPal's sandbox (plan 7.4): the GB
 * sandbox buyer's login for the PayPal button and PayPal's test card for the
 * card fields, shown wherever the owner's page asks for an authorisation.
 * The words are this unit's (D11, flagged).
 *
 * @param props - The buyer's login, or null when the server was given none.
 * @param props.login - The login.
 * @returns The panel.
 */
export function SandboxDetails({ login }: { readonly login: SandboxBuyerLogin | null }) {
  return (
    <aside className={styles.sandbox} aria-labelledby="sandbox-heading">
      <h2 id="sandbox-heading">Testing in PayPal&apos;s sandbox</h2>
      <p>
        No real money moves. Pay with PayPal using the sandbox buyer below, or pay by card with
        PayPal&apos;s test card and any name.
      </p>
      <dl>
        {login ? (
          <>
            <div>
              <dt>PayPal email</dt>
              <dd>
                <code>{login.email}</code>
              </dd>
            </div>
            <div>
              <dt>PayPal password</dt>
              <dd>
                <code>{login.password}</code>
              </dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>PayPal login</dt>
              <dd>In the Testing instructions of pawhold&apos;s README.</dd>
            </div>
          </>
        )}
        <div>
          <dt>Card number</dt>
          <dd>
            <code>{groupedCardNumber(SANDBOX_TEST_CARD.number)}</code>
          </dd>
        </div>
        <div>
          <dt>Expiry</dt>
          <dd>
            <code>{SANDBOX_TEST_CARD.expiry}</code>
          </dd>
        </div>
        <div>
          <dt>Security code</dt>
          <dd>
            <code>{SANDBOX_TEST_CARD.cvv}</code>
          </dd>
        </div>
      </dl>
    </aside>
  );
}
