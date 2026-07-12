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

async function getBestCategory(query, token) {
  // Ask eBay's own taxonomy what category this query belongs to, so we can
  // restrict the search to it. This is what actually keeps "iPhone case"
  // and "Galaxy S26 Ultra screen protector" out of a phone search — they
  // live in a different category on eBay's backend, not just different words.
  try {
    const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) return null;

    const data = await response.json();
    const top = data.categorySuggestions?.[0];
    return top?.category?.categoryId || null;
  } catch (err) {
    console.error('Category lookup failed, continuing without it:', err.message);
    return null; // non-fatal — we fall back to an unfiltered search below
  }
}

async function searchEbay(query, token, categoryId) {
  // No price sort here on purpose — sorting cheapest-first pulls in cases, screen
  // protectors, and "for parts" junk before any real listings. Default relevance
  // ranking weighs title match instead, which is what we actually want.
  const cleanedQuery = `${query} -case -cover -skin -decal -"screen protector" -parts -"for parts" -lot -replacement -sticker`;
  let url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(cleanedQuery)}&limit=30`;

  if (categoryId) {
    url += `&category_ids=${categoryId}`;
  }

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

function median(sortedArr) {
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 !== 0
    ? sortedArr[mid]
    : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}

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

  const rawPrices = listings
    .map(l => parseFloat(l.price?.value))
    .filter(p => !isNaN(p) && p > 0)
    .sort((a, b) => a - b);

  if (!rawPrices.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      reasoning: "Found listings but couldn't read pricing from them.",
      comps: []
    };
  }

  // Reject outliers relative to the median rather than trimming by list position —
  // this handles a cluster of misfiled/junk listings (e.g. a page of $1 accessories)
  // that would otherwise anchor the low end no matter how they're sorted.
  const med = median(rawPrices);
  const usable = rawPrices.filter(p => p >= med * 0.4 && p <= med * 2.5);
  const prices = usable.length >= 3 ? usable : rawPrices;

  const low = prices[0];
  const high = prices[prices.length - 1];
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;

  const comps = listings
    .filter(l => {
      const p = parseFloat(l.price?.value);
      return !isNaN(p) && p >= med * 0.4 && p <= med * 2.5;
    })
    .slice(0, 3)
    .map(l => ({
      source: `eBay listing — ${l.condition || 'condition unspecified'}`,
      price: `$${parseFloat(l.price?.value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    }));

  return {
    low: Math.round(low * multiplier),
    high: Math.round(high * multiplier),
    best_guess: Math.round(avg * multiplier),
    reasoning: `Based on ${prices.length} comparable eBay listings (of ${listings.length} found) for similar items, adjusted for "${condition}" condition. These reflect current asking prices, not confirmed sold prices.`,
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
    const categoryId = await getBestCategory(item, token);
    let listings = await searchEbay(item, token, categoryId);

    // If the category guess was wrong or too narrow and returned nothing, retry unfiltered
    if (listings.length === 0 && categoryId) {
      listings = await searchEbay(item, token, null);
    }

    const result = computeValuation(listings, condition);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Appraisal failed', detail: String(err.message || err) });
  }
}