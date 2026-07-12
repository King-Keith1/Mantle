// eBay Marketplace Account Deletion Notification endpoint.
// Required for production API access — eBay validates this endpoint before your keyset fully activates.
//
// Requires two env vars on your deployment:
//   EBAY_VERIFICATION_TOKEN  - must exactly match the token you paste into eBay's dashboard
//   EBAY_NOTIFICATION_ENDPOINT_URL - the full public URL of THIS endpoint, e.g.
//                                    https://your-app.vercel.app/api/ebay-notifications
//
// GET  -> eBay's verification challenge. Must respond with a specific SHA-256 hash.
// POST -> real account-deletion notifications once verified. Must respond 200 quickly.

import crypto from 'crypto';

export default async function handler(req, res) {
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;
  const endpointUrl = process.env.EBAY_NOTIFICATION_ENDPOINT_URL;

  if (req.method === 'GET') {
    const challengeCode = req.query?.challenge_code;

    if (!challengeCode) {
      res.status(400).json({ error: 'Missing challenge_code' });
      return;
    }

    if (!verificationToken || !endpointUrl) {
      // These must be set before eBay will ever succeed at verifying this endpoint.
      res.status(500).json({ error: 'Server not configured: missing EBAY_VERIFICATION_TOKEN or EBAY_NOTIFICATION_ENDPOINT_URL' });
      return;
    }

    // eBay's required order: challengeCode + verificationToken + endpoint, SHA-256, hex digest
    const hash = crypto.createHash('sha256');
    hash.update(challengeCode);
    hash.update(verificationToken);
    hash.update(endpointUrl);
    const challengeResponse = hash.digest('hex');

    res.status(200).json({ challengeResponse });
    return;
  }

  if (req.method === 'POST') {
    // Real account-deletion notification from eBay. Acknowledge quickly with 200.
    // For this prototype we just log it — a production app would queue deletion
    // of that user's data from your own database here.
    console.log('eBay account deletion notification received:', JSON.stringify(req.body));
    res.status(200).json({ received: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}