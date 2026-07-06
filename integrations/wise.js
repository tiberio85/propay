// Wise (TransferWise) payout helper.
// Used to send funds collected via Stripe out to a beneficiary bank account,
// e.g. a seller's Panamanian bank account, since Stripe Connect does not
// support Panama as a connected-account country.
//
// Requires a Wise Business account + API token (WISE_API_TOKEN, WISE_PROFILE_ID).
// Docs: https://api-docs.transferwise.com

const fetch = require('node-fetch');

const WISE_API_BASE = process.env.WISE_API_BASE || 'https://api.transferwise.com';

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WISE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function wiseRequest(path, options = {}) {
  const res = await fetch(`${WISE_API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.message || `Wise API error (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// 1) Create a quote for converting sourceCurrency -> targetCurrency
async function createQuote({ sourceCurrency = 'EUR', targetCurrency, sourceAmount }) {
  return wiseRequest('/v3/quotes', {
    method: 'POST',
    body: JSON.stringify({
      profile: process.env.WISE_PROFILE_ID,
      sourceCurrency,
      targetCurrency,
      sourceAmount
    })
  });
}

// 2) Create a recipient (beneficiary) bank account, e.g. Panama (PAB/USD accounts)
async function createRecipient({ currency, accountHolderName, details, type = 'panama' }) {
  return wiseRequest('/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({
      profile: process.env.WISE_PROFILE_ID,
      accountHolderName,
      currency,
      type,
      details
    })
  });
}

// 3) Create the transfer linking a quote to a recipient
async function createTransfer({ targetAccountId, quoteId, customerTransactionId }) {
  return wiseRequest('/v1/transfers', {
    method: 'POST',
    body: JSON.stringify({
      targetAccount: targetAccountId,
      quoteUuid: quoteId,
      customerTransactionId: customerTransactionId || `propay-${Date.now()}`
    })
  });
}

// 4) Fund the transfer from your Wise balance
async function fundTransfer(transferId) {
  return wiseRequest(`/v3/profiles/${process.env.WISE_PROFILE_ID}/transfers/${transferId}/payments`, {
    method: 'POST',
    body: JSON.stringify({ type: 'BALANCE' })
  });
}

// Convenience: quote + recipient + transfer + fund, in one call
async function payoutToRecipient({ targetCurrency, sourceAmount, sourceCurrency, accountHolderName, details, recipientType }) {
  const quote = await createQuote({ sourceCurrency, targetCurrency, sourceAmount });
  const recipient = await createRecipient({ currency: targetCurrency, accountHolderName, details, type: recipientType });
  const transfer = await createTransfer({ targetAccountId: recipient.id, quoteId: quote.id });
  const funded = await fundTransfer(transfer.id);
  return { quote, recipient, transfer, funded };
}

module.exports = {
  createQuote,
  createRecipient,
  createTransfer,
  fundTransfer,
  payoutToRecipient
};
