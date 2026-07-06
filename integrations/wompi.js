// Wompi (Bancolombia) integration for Colombia: PSE, Nequi, Bancolombia
// Transfer/QR and bank accounts. Daviplata is NOT supported by Wompi as of
// this writing — see integrations/epayco.js for the Daviplata flow.
// Docs: https://docs.wompi.co
//
// Requires a Wompi merchant account (sandbox or production) with:
//   WOMPI_PUBLIC_KEY, WOMPI_PRIVATE_KEY, WOMPI_EVENTS_SECRET
// Get these from https://comercios.wompi.co after merchant onboarding (KYC).

const fetch = require('node-fetch');
const crypto = require('crypto');

const WOMPI_BASE = process.env.WOMPI_ENV === 'production'
  ? 'https://production.wompi.co/v1'
  : 'https://sandbox.wompi.co/v1';

async function getAcceptanceToken() {
  const res = await fetch(`${WOMPI_BASE}/merchants/${process.env.WOMPI_PUBLIC_KEY}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.reason || 'wompi merchant lookup failed');
  return body.data.presigned_acceptance.acceptance_token;
}

async function wompiRequest(path, options = {}) {
  const res = await fetch(`${WOMPI_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.WOMPI_PRIVATE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error?.reason || `Wompi API error (${res.status})`);
    err.body = body;
    throw err;
  }
  return body;
}

// Nequi: customer approves the charge push notification in the Nequi app.
async function createNequiPayment({ amountInCents, currency = 'COP', customerEmail, phoneNumber, reference }) {
  const acceptance_token = await getAcceptanceToken();
  return wompiRequest('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      acceptance_token,
      amount_in_cents: amountInCents,
      currency,
      customer_email: customerEmail,
      payment_method: { type: 'NEQUI', phone_number: phoneNumber },
      reference: reference || `propay-nequi-${Date.now()}`
    })
  });
}

// PSE: redirects the customer to their bank to authorize a transfer.
async function createPSEPayment({
  amountInCents, currency = 'COP', customerEmail, reference, redirectUrl,
  financialInstitutionCode, userType, userLegalIdType, userLegalId, fullName
}) {
  const acceptance_token = await getAcceptanceToken();
  return wompiRequest('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      acceptance_token,
      amount_in_cents: amountInCents,
      currency,
      customer_email: customerEmail,
      payment_method: {
        type: 'PSE',
        user_type: userType,
        user_legal_id_type: userLegalIdType,
        user_legal_id: userLegalId,
        financial_institution_code: financialInstitutionCode,
        payment_description: 'ProPay payment'
      },
      customer_data: { full_name: fullName },
      redirect_url: redirectUrl,
      reference: reference || `propay-pse-${Date.now()}`
    })
  });
}

// Bancolombia Transfer / QR (direct bank-account debit for Bancolombia customers).
async function createBancolombiaTransfer({ amountInCents, currency = 'COP', customerEmail, redirectUrl, reference }) {
  const acceptance_token = await getAcceptanceToken();
  return wompiRequest('/transactions', {
    method: 'POST',
    body: JSON.stringify({
      acceptance_token,
      amount_in_cents: amountInCents,
      currency,
      customer_email: customerEmail,
      payment_method: { type: 'BANCOLOMBIA_TRANSFER', payment_description: 'ProPay payment' },
      redirect_url: redirectUrl,
      reference: reference || `propay-bancolombia-${Date.now()}`
    })
  });
}

async function listPSEBanks() {
  return wompiRequest('/pse/financial_institutions');
}

async function getTransaction(id) {
  return wompiRequest(`/transactions/${id}`);
}

// Verifies the `event.signature.checksum` Wompi sends on webhook calls.
function verifyWebhookSignature(event) {
  const { properties, checksum } = event.signature;
  const concatenatedValues = properties
    .map((path) => path.split('.').reduce((obj, key) => obj?.[key], event.data))
    .join('');
  const toHash = `${concatenatedValues}${event.timestamp}${process.env.WOMPI_EVENTS_SECRET}`;
  const expected = crypto.createHash('sha256').update(toHash).digest('hex');
  return expected === checksum;
}

module.exports = {
  createNequiPayment,
  createPSEPayment,
  createBancolombiaTransfer,
  listPSEBanks,
  getTransaction,
  getAcceptanceToken,
  verifyWebhookSignature
};
