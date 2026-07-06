// Minimal Node/Express server for ProPay
// - Creates Stripe Checkout sessions that support card, SEPA Direct Debit, and ACH (US bank account)
// - Supports routing funds to Stripe Connected Accounts (marketplace) via transfer_data
// - Webhook endpoint to receive and verify Stripe events
//
// NOTE: This is an example for integration and does NOT replace production hardening.
// Install dependencies:
//   npm install express stripe body-parser dotenv cors

require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/', (req, res) => res.send('ProPay Stripe integration server running'));

// Create a Checkout Session
// Request body JSON (examples):
// { amount: 1000, currency: 'eur', connectedAccountId: 'acct_...', platformFee: 100 }
app.post('/create-checkout-session', async (req, res) => {
  const { amount = 1000, currency = 'eur', connectedAccountId = null, platformFee = 0, metadata = {} } = req.body;

  try {
    const sessionData = {
      payment_method_types: ['card', 'sepa_debit'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: 'ProPay Payment' },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      success_url: `${process.env.SUCCESS_URL || 'https://example.com/success'}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CANCEL_URL || 'https://example.com/cancel'}`,
      metadata
    };

    // If marketplace payout is required, instruct Stripe to transfer part or all of the funds
    // to a connected account by using payment_intent_data.transfer_data.destination
    if (connectedAccountId) {
      sessionData.payment_intent_data = {
        transfer_data: {
          destination: connectedAccountId
        }
      };
      // Optionally take an application fee for the platform (in cents)
      if (platformFee && Number(platformFee) > 0) {
        sessionData.payment_intent_data.application_fee_amount = platformFee;
      }
    }

    const session = await stripe.checkout.sessions.create(sessionData);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('create-checkout-session error', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a Stripe Connected Account (Express) and return onboarding link
// Request: { country: 'US' }
app.post('/create-connected-account', async (req, res) => {
  const { country = 'US', type = 'express' } = req.body;
  try {
    const account = await stripe.accounts.create({
      type,
      country,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
    });

    // Create an account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: process.env.SUCCESS_URL || 'https://example.com/reauth',
      return_url: process.env.SUCCESS_URL || 'https://example.com/success',
      type: 'account_onboarding'
    });

    res.json({ account, accountLinkUrl: accountLink.url });
  } catch (err) {
    console.error('create-connected-account error', err);
    res.status(500).json({ error: err.message });
  }
});

// Example: create a Transfer to a connected account (post-payment settlement)
app.post('/transfer-to-connected', async (req, res) => {
  const { connectedAccountId, amount, currency = 'eur', idempotencyKey } = req.body;
  if (!connectedAccountId || !amount) return res.status(400).json({ error: 'missing params' });

  try {
    const transfer = await stripe.transfers.create({
      amount,
      currency,
      destination: connectedAccountId
    }, {
      idempotencyKey: idempotencyKey || `transfer-${Date.now()}`
    });

    res.json({ transfer });
  } catch (err) {
    console.error('transfer-to-connected error', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook endpoint (requires raw body for signature verification)
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events of interest
  switch (event.type) {
    case 'checkout.session.completed':
      {
        const session = event.data.object;
        console.log('checkout.session.completed', session.id);
        // Mark order as paid, create internal records, start fulfilment.
      }
      break;
    case 'payment_intent.succeeded':
      console.log('payment_intent.succeeded', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('payment_intent.payment_failed', event.data.object.id);
      break;
    case 'charge.refunded':
      console.log('charge.refunded', event.data.object.id);
      break;
    default:
      console.log('Unhandled stripe event type', event.type);
  }

  res.json({ received: true });
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`ProPay Stripe server listening on ${port}`));
