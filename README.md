# ProPay

Payments prototype: a static HTML dashboard (`propay-prototype.html`) wired to a
Node/Express server (`server.js`) that integrates Stripe (cards, SEPA Direct
Debit, ACH, Connect marketplace payouts) and Wise (cross-border bank payouts,
e.g. to Panama, where Stripe Connect isn't available).

## Setup

```bash
npm install
cp .env.example .env   # fill in your Stripe/Wise keys
npm start
```

The server listens on `http://localhost:4242` by default (`PORT` in `.env`).

## Running the prototype UI

Open `propay-prototype.html` directly in a browser (no build step). The
"Pay with Stripe" button calls `POST /create-checkout-session` on the server
and redirects to Stripe-hosted Checkout. If the server runs on a different
host/port, set `window.PROPAY_API_BASE` before the script runs, e.g.:

```html
<script>window.PROPAY_API_BASE = 'https://api.yourdomain.com';</script>
```

## Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Health check |
| `POST /create-checkout-session` | Card + SEPA Direct Debit Checkout, optional marketplace routing via `connectedAccountId` |
| `POST /create-connected-account` | Create a Stripe Express connected account + onboarding link |
| `POST /transfer-to-connected` | Transfer settled funds to a connected account |
| `POST /create-ach-payment-intent` | Charge a US bank account (ACH) with an existing payment method |
| `POST /create-sepa-setup-intent` | Collect a SEPA Direct Debit mandate for future off-session charges |
| `POST /charge-sepa-mandate` | Charge a previously mandated SEPA payment method |
| `POST /wise-payout` | Send collected funds to a beneficiary bank account via Wise (quote → recipient → transfer → fund) |
| `POST /webhook` | Stripe webhook receiver (signature-verified) |

## Testing webhooks locally

```bash
stripe listen --forward-to http://localhost:4242/webhook
```

Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`.

## Panama / marketplace payouts

Stripe Connect does not support Panama as a connected-account country. The
recommended flow is: accept payments with Stripe (cards, SEPA, ACH), settle to
your own Stripe balance, then use `POST /wise-payout` to send the seller's
share to their Panamanian bank account via Wise.

## Production checklist

- Never commit real secret keys — use your host's secret manager.
- Serve `SUCCESS_URL`/`CANCEL_URL`/webhook endpoints over HTTPS.
- Add idempotency keys on all payment/payout calls before going live (some
  endpoints above already do; extend the same pattern to `/wise-payout`).
- Implement KYC/AML checks required by Stripe/Wise for your regions.
- Reconcile `payment_intent`/`charge`/`transfer`/Wise `transfer` ids against
  your internal order records.
