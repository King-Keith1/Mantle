// Serverless function: POST { item, category, age, condition } -> { low, high, best_guess, reasoning, comps }
// Keeps eBay credentials server-side only (set as EBAY_CLIENT_ID / EBAY_CLIENT_SECRET in Vercel env vars).

let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('eBay credentials not configured on the server yet');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay auth failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh a little early
  return cachedToken;
}

async function searchEbay(query, token) {
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=25&sort=price`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay search failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.itemSummaries || [];
}

const CONDITION_MULTIPLIER = {
  'Mint / sealed, never used': 1.0,
  'Excellent, barely used': 0.9,
  'Good, some visible wear': 0.75,
  'Worn / damaged': 0.55
};

function computeValuation(listings, condition) {
  const multiplier = CONDITION_MULTIPLIER[condition] ?? 0.85;

  if (!listings.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      reasoning: "No comparable listings found on eBay for this item right now. Try a more specific or more common name for it.",
      comps: []
    };
  }

  const prices = listings
    .map(l => parseFloat(l.price?.value))
    .filter(p => !isNaN(p) && p > 0)
    .sort((a, b) => a - b);

  if (!prices.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      reasoning: "Found listings but couldn't read pricing from them.",
      comps: []
    };
  }

  // trim the extreme 20% on each end so one wildly over/underpriced listing doesn't skew the range
  const trim = Math.floor(prices.length * 0.2);
  const usable = prices.length > 4 ? prices.slice(trim, prices.length - trim) : prices;

  const low = usable[0];
  const high = usable[usable.length - 1];
  const avg = usable.reduce((sum, p) => sum + p, 0) / usable.length;

  const comps = listings.slice(0, 3).map(l => ({
    source: `eBay listing — ${l.condition || 'condition unspecified'}`,
    price: `$${parseFloat(l.price?.value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }));

  return {
    low: Math.round(low * multiplier),
    high: Math.round(high * multiplier),
    best_guess: Math.round(avg * multiplier),
    reasoning: `Based on ${listings.length} current eBay listings for similar items, adjusted for "${condition}" condition. These reflect current asking prices, not confirmed sold prices.`,
    comps
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { item, condition } = req.body || {};

  if (!item || typeof item !== 'string') {
    res.status(400).json({ error: 'Item name is required' });
    return;
  }

  try {
    const token = await getEbayToken();
    const listings = await searchEbay(item, token);
    const result = computeValuation(listings, condition);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Appraisal failed', detail: String(err.message || err) });
  }
}