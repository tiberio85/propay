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
| `POST /co/nequi/pay` | Nequi push payment (Wompi) — customer approves in the Nequi app |
| `POST /co/pse/pay` | PSE bank transfer (Wompi) — covers Colombian bank accounts |
| `GET /co/pse/banks` | List PSE-participating banks (`financial_institution_code` values) |
| `POST /co/bancolombia/pay` | Bancolombia Transfer/QR (Wompi) |
| `GET /co/transaction/:id` | Poll a Wompi transaction's status |
| `POST /co/daviplata/pay` | Daviplata push payment (ePayco — Wompi has no Daviplata support) |
| `POST /co/wompi/webhook` | Wompi webhook receiver (checksum-verified) |

## Colombia (Nequi, Daviplata, PSE bank accounts)

Two providers are used because no single one covers everything requested:

- **Wompi** (Bancolombia) — PSE (bank accounts), Nequi, Bancolombia Transfer/QR, cards.
- **ePayco** — Daviplata only, since Wompi doesn't support it.

Both require a real merchant account (KYC with a Colombian legal entity/RUT) —
sign up at https://comercios.wompi.co and https://dashboard.epayco.co, then
copy the API keys into `.env` (see `.env.example`). `WOMPI_ENV=sandbox` lets
you test with Wompi's sandbox keys before switching to `production`.

Nequi and Daviplata are both **push** payments: the server starts the charge,
the customer approves it in their app, and you poll (`/co/transaction/:id`
for Wompi, or listen to `/co/wompi/webhook`) until the status is `APPROVED`.
PSE and Bancolombia Transfer redirect the customer to their bank/app instead.

## Deploying to a real server (Render, free tier)

This repo includes `render.yaml` so Render can deploy it as a Blueprint:

1. Push this branch to GitHub (already done if you're reading this from the repo).
2. Go to https://dashboard.render.com/blueprints → "New Blueprint Instance" → pick this repo/branch.
3. Render reads `render.yaml` and creates a free Node web service.
4. Fill in the secret env vars it prompts for (Stripe, Wise, Wompi, ePayco keys) — they're marked `sync: false` so Render asks for them instead of storing them in the repo.
5. Once deployed, Render gives you an HTTPS URL like `https://propay.onrender.com`. Update:
   - `SUCCESS_URL` / `CANCEL_URL` to that URL.
   - The webhook URL in your Stripe dashboard to `https://propay.onrender.com/webhook`.
   - The webhook URL in your Wompi dashboard to `https://propay.onrender.com/co/wompi/webhook`.
   - `window.PROPAY_API_BASE` in `propay-prototype.html` to that URL.

Free tier notes: the service sleeps after inactivity and wakes on the next
request (a few seconds' delay) — fine for a prototype, upgrade to a paid plan
before handling real production traffic.

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
