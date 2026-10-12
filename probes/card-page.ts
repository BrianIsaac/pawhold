import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * P6's minimal page: PayPal's JS SDK v6 card fields, served from localhost
 * the way PayPal's own v6 sample is (paypal-examples/v6-web-sdk-sample-integration,
 * client/components/cardFields/oneTimePayment, read 12 October 2026). The
 * order is made by the probe on the server side; the page only mounts the
 * fields and submits them for the order id the probe hands it. Eligibility
 * is read and recorded but does not gate the fields: PayPal's card-fields
 * guide says "The card may not appear in the eligibility response yet.
 * Integrate defensively." (developer.paypal.com/expanded/card-fields, read
 * 12 October 2026), and the sandbox's eligibility call failed intermittently.
 */

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

/**
 * The page. The client id is the app's browser-safe id; it is served to the
 * local browser only and never written anywhere.
 *
 * @param clientId - The sandbox app's client id.
 * @returns The HTML.
 */
export function cardPageHtml(clientId: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>pawhold probe: card fields</title>
<style>.card-field { height: 3rem; width: 24rem; margin-bottom: 1rem; }</style>
</head>
<body>
<div id="paypal-card-fields-name" class="card-field"></div>
<div id="paypal-card-fields-number" class="card-field"></div>
<div id="paypal-card-fields-expiry" class="card-field"></div>
<div id="paypal-card-fields-cvv" class="card-field"></div>
<script>
window.__probe = { ready: false, eligible: null, eligibilityError: null, error: null };
async function onPayPalWebSdkLoaded() {
  try {
    const sdk = await window.paypal.createInstance({ clientId: ${scriptString(clientId)}, components: ["card-fields"] });
    try {
      const methods = await sdk.findEligibleMethods({ currencyCode: "GBP" });
      window.__probe.eligible = methods.isEligible("advanced_cards");
    } catch (error) {
      window.__probe.eligibilityError = String(error && error.message || error);
    }
    const session = sdk.createCardFieldsOneTimePaymentSession();
    for (const [type, placeholder] of [["name", "Name"], ["number", "Card number"], ["expiry", "MM/YY"], ["cvv", "CVV"]]) {
      document.querySelector("#paypal-card-fields-" + type).appendChild(session.createCardFieldsComponent({ type, placeholder }));
    }
    window.__probeSubmit = async (orderId) => {
      try {
        const { data, state } = await session.submit(orderId, { billingAddress: { countryCode: "GB", postalCode: "SW1A 1AA" } });
        return { state, data: JSON.parse(JSON.stringify(data ?? null)) };
      } catch (error) {
        return { state: "threw", data: { message: String(error && error.message || error) } };
      }
    };
    window.__probe.ready = true;
  } catch (error) {
    window.__probe.error = String(error && error.message || error);
  }
}
</script>
<script async src="${SDK_URL}" onload="onPayPalWebSdkLoaded()" onerror="window.__probe.error = 'the SDK script did not load'"></script>
</body>
</html>`;
}

/**
 * A string as a JavaScript literal safe inside a `<script>` element: JSON,
 * with `<` escaped so the text can never close the element.
 *
 * @param value - The string.
 * @returns The literal.
 */
function scriptString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** A running page server. */
export interface CardPageServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serves the card page on localhost, on a free port.
 *
 * @param clientId - The sandbox app's client id.
 * @returns The server's address and its closer.
 */
export async function serveCardPage(clientId: string): Promise<CardPageServer> {
  const html = cardPageHtml(clientId);
  const server: Server = createServer((request, response) => {
    if (request.url === "/" || request.url?.startsWith("/?")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
