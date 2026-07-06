// ePayco integration — used only for Daviplata, since Wompi does not support
// it. Docs: https://docs.epayco.co (verify endpoint/field names there before
// going live; ePayco's cash/wallet API has changed shape across versions).
//
// Requires an ePayco merchant account with: EPAYCO_PUBLIC_KEY, EPAYCO_PRIVATE_KEY

const fetch = require('node-fetch');

const EPAYCO_BASE = 'https://api.secure.payco.co';

async function getToken() {
  const auth = Buffer.from(`${process.env.EPAYCO_PUBLIC_KEY}:${process.env.EPAYCO_PRIVATE_KEY}`).toString('base64');
  const res = await fetch(`${EPAYCO_BASE}/login`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || 'epayco auth failed');
  return body.token;
}

// Push payment request to the customer's Daviplata app.
async function createDaviplataPayment({ amount, docNumber, phone, invoice, description }) {
  const token = await getToken();
  const res = await fetch(`${EPAYCO_BASE}/payment/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'daviplata',
      value: amount,
      docType: 'CC',
      docNumber,
      phone,
      invoice: invoice || `propay-daviplata-${Date.now()}`,
      description: description || 'ProPay payment'
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || 'epayco daviplata payment failed');
  return body;
}

async function getTransactionStatus(ref) {
  const token = await getToken();
  const res = await fetch(`${EPAYCO_BASE}/transaction/response/${ref}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || 'epayco status lookup failed');
  return body;
}

module.exports = { getToken, createDaviplataPayment, getTransactionStatus };
