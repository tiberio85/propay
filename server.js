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
const wise = require('./integrations/wise');
const wompi = require('./integrations/wompi');
const epayco = require('./integrations/epayco');

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

// ACH: create a PaymentIntent for a US bank account debit.
// Client must first collect the bank account via Stripe Financial Connections
// or Plaid and obtain a payment_method id (pm_...) before calling this.
// Request: { amount, currency: 'usd', paymentMethodId, customerId }
app.post('/create-ach-payment-intent', async (req, res) => {
  const { amount, currency = 'usd', paymentMethodId, customerId } = req.body;
  if (!amount || !paymentMethodId) return res.status(400).json({ error: 'missing params' });

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      payment_method_types: ['us_bank_account'],
      confirm: true,
      mandate_data: {
        customer_acceptance: {
          type: 'online',
          online: { ip_address: req.ip, user_agent: req.headers['user-agent'] }
        }
      }
    });

    res.json({ paymentIntent });
  } catch (err) {
    console.error('create-ach-payment-intent error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPA: create a SetupIntent to collect a SEPA Direct Debit mandate.
// Request: { customerId }
app.post('/create-sepa-setup-intent', async (req, res) => {
  const { customerId } = req.body;
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['sepa_debit']
    });

    res.json({ setupIntent });
  } catch (err) {
    console.error('create-sepa-setup-intent error', err);
    res.status(500).json({ error: err.message });
  }
});

// SEPA: charge a previously mandated payment method off-session.
// Request: { amount, currency: 'eur', customerId, paymentMethodId }
app.post('/charge-sepa-mandate', async (req, res) => {
  const { amount, currency = 'eur', customerId, paymentMethodId } = req.body;
  if (!amount || !customerId || !paymentMethodId) return res.status(400).json({ error: 'missing params' });

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      payment_method_types: ['sepa_debit'],
      off_session: true,
      confirm: true
    });

    res.json({ paymentIntent });
  } catch (err) {
    console.error('charge-sepa-mandate error', err);
    res.status(500).json({ error: err.message });
  }
});

// Wise payout: send collected funds to a beneficiary bank account (e.g. Panama),
// since Stripe Connect does not support Panama as a connected-account country.
// Request: { targetCurrency, sourceAmount, sourceCurrency, accountHolderName, details, recipientType }
app.post('/wise-payout', async (req, res) => {
  const { targetCurrency, sourceAmount, sourceCurrency = 'EUR', accountHolderName, details, recipientType } = req.body;
  if (!targetCurrency || !sourceAmount || !accountHolderName || !details) {
    return res.status(400).json({ error: 'missing params' });
  }

  try {
    const result = await wise.payoutToRecipient({
      targetCurrency, sourceAmount, sourceCurrency, accountHolderName, details, recipientType
    });
    res.json(result);
  } catch (err) {
    console.error('wise-payout error', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Colombia payment methods ---

// Nequi push payment via Wompi. The customer approves the charge in their
// Nequi app; poll GET /co/transaction/:id until status is APPROVED.
// Request: { amountInCents, customerEmail, phoneNumber, reference }
app.post('/co/nequi/pay', async (req, res) => {
  const { amountInCents, customerEmail, phoneNumber, reference } = req.body;
  if (!amountInCents || !customerEmail || !phoneNumber) return res.status(400).json({ error: 'missing params' });

  try {
    const transaction = await wompi.createNequiPayment({ amountInCents, customerEmail, phoneNumber, reference });
    res.json(transaction);
  } catch (err) {
    console.error('co/nequi/pay error', err);
    res.status(500).json({ error: err.message });
  }
});

// PSE bank transfer via Wompi (covers Colombian bank accounts). List banks
// first with GET /co/pse/banks to get financialInstitutionCode.
// Request: { amountInCents, customerEmail, redirectUrl, financialInstitutionCode, userType, userLegalIdType, userLegalId, fullName, reference }
app.post('/co/pse/pay', async (req, res) => {
  const { amountInCents, customerEmail, redirectUrl, financialInstitutionCode, userType, userLegalIdType, userLegalId, fullName, reference } = req.body;
  if (!amountInCents || !customerEmail || !financialInstitutionCode || !redirectUrl) {
    return res.status(400).json({ error: 'missing params' });
  }

  try {
    const transaction = await wompi.createPSEPayment({
      amountInCents, customerEmail, redirectUrl, financialInstitutionCode,
      userType, userLegalIdType, userLegalId, fullName, reference
    });
    res.json(transaction);
  } catch (err) {
    console.error('co/pse/pay error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/co/pse/banks', async (req, res) => {
  try {
    res.json(await wompi.listPSEBanks());
  } catch (err) {
    console.error('co/pse/banks error', err);
    res.status(500).json({ error: err.message });
  }
});

// Bancolombia Transfer/QR via Wompi.
// Request: { amountInCents, customerEmail, redirectUrl, reference }
app.post('/co/bancolombia/pay', async (req, res) => {
  const { amountInCents, customerEmail, redirectUrl, reference } = req.body;
  if (!amountInCents || !customerEmail || !redirectUrl) return res.status(400).json({ error: 'missing params' });

  try {
    const transaction = await wompi.createBancolombiaTransfer({ amountInCents, customerEmail, redirectUrl, reference });
    res.json(transaction);
  } catch (err) {
    console.error('co/bancolombia/pay error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/co/transaction/:id', async (req, res) => {
  try {
    res.json(await wompi.getTransaction(req.params.id));
  } catch (err) {
    console.error('co/transaction error', err);
    res.status(500).json({ error: err.message });
  }
});

// Daviplata push payment via ePayco (Wompi does not support Daviplata).
// Request: { amount, docNumber, phone, invoice, description }
app.post('/co/daviplata/pay', async (req, res) => {
  const { amount, docNumber, phone, invoice, description } = req.body;
  if (!amount || !docNumber || !phone) return res.status(400).json({ error: 'missing params' });

  try {
    const result = await epayco.createDaviplataPayment({ amount, docNumber, phone, invoice, description });
    res.json(result);
  } catch (err) {
    console.error('co/daviplata/pay error', err);
    res.status(500).json({ error: err.message });
  }
});

// Wompi webhook (transaction.updated events for Nequi/PSE/Bancolombia).
app.post('/co/wompi/webhook', bodyParser.json(), (req, res) => {
  const event = req.body;
  if (!wompi.verifyWebhookSignature(event)) {
    console.error('Invalid Wompi webhook signature');
    return res.status(400).json({ error: 'invalid signature' });
  }

  console.log('Wompi event', event.event, event.data?.transaction?.id, event.data?.transaction?.status);
  res.json({ received: true });
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
