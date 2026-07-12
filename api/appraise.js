// Serverless function: POST { item, category, age, condition } -> { low, high, best_guess, reasoning, comps }
// Keeps eBay credentials server-side only (set as EBAY_CLIENT_ID / EBAY_CLIENT_SECRET in Vercel env vars).

// Currency symbols like "R" for Rand aren't recognized by every locale — most
// fall back to printing the ISO code instead. Pinning a native locale per
// currency gets the actual symbol rendered correctly regardless of the visitor's
// own device locale.
const CURRENCY_LOCALE = {
  ZAR: 'en-ZA', USD: 'en-US', GBP: 'en-GB', EUR: 'de-DE',
  CAD: 'en-CA', AUD: 'en-AU', NZD: 'en-NZ', JPY: 'ja-JP', CNY: 'zh-CN', INR: 'en-IN',
  BRL: 'pt-BR', MXN: 'es-MX', ARS: 'es-AR', CHF: 'de-CH', SEK: 'sv-SE', NOK: 'nb-NO', DKK: 'da-DK',
  KES: 'en-KE', NGN: 'en-NG', GHS: 'en-GH', EGP: 'ar-EG', MAD: 'ar-MA',
  AED: 'ar-AE', SAR: 'ar-SA', ILS: 'he-IL', TRY: 'tr-TR',
  SGD: 'en-SG', HKD: 'en-HK', KRW: 'ko-KR', THB: 'th-TH', MYR: 'ms-MY', PHP: 'en-PH', IDR: 'id-ID', VND: 'vi-VN',
  PLN: 'pl-PL', CZK: 'cs-CZ', HUF: 'hu-HU', RON: 'ro-RO'
};

function money(n, currency) {
  const locale = CURRENCY_LOCALE[currency] || 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

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

async function searchEbay(query, token, categoryId, marketplaceId) {
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
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay search failed on ${marketplaceId} (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.itemSummaries || [];
}

// Some brands (Honor, Xiaomi, etc.) have thin US eBay presence but strong UK/EU
// presence. Searching only EBAY_US meant those items matched on whatever thin
// scraps existed there — sometimes a single mispriced or unrelated listing.
// Searching a second marketplace and merging results gives real sample size.
async function searchMultipleMarketplaces(query, token, categoryId) {
  const marketplaces = ['EBAY_US', 'EBAY_GB'];

  const results = await Promise.all(
    marketplaces.map(async (mp) => {
      try {
        // categoryId comes from the US category tree — only safe to apply on EBAY_US.
        // Other marketplaces get keyword-only filtering via the exclusion terms.
        const mpCategoryId = mp === 'EBAY_US' ? categoryId : null;
        const items = await searchEbay(query, token, mpCategoryId, mp);
        return items;
      } catch (err) {
        console.error(`Search failed on ${mp}, continuing with other marketplaces:`, err.message);
        return [];
      }
    })
  );

  return results.flat();
}

// Country -> currency mapping for common markets. Falls back to USD for anything
// not listed, which covers most of the world reasonably (many countries either
// use USD directly or it's a familiar reference currency).
const COUNTRY_CURRENCY = {
  ZA: 'ZAR', US: 'USD', GB: 'GBP', IE: 'EUR',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', IN: 'INR',
  BR: 'BRL', MX: 'MXN', AR: 'ARS', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  KE: 'KES', NG: 'NGN', GH: 'GHS', EG: 'EGP', MA: 'MAD',
  AE: 'AED', SA: 'SAR', IL: 'ILS', TR: 'TRY',
  SG: 'SGD', HK: 'HKD', KR: 'KRW', TH: 'THB', MY: 'MYR', PH: 'PHP', ID: 'IDR', VN: 'VND',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON'
};

function getCurrencyForRequest(req) {
  // Vercel automatically attaches geolocation headers based on the visitor's IP —
  // no extra API call or client-side detection needed.
  const country = req.headers['x-vercel-ip-country'];
  return COUNTRY_CURRENCY[country] || 'USD';
}

let rateCache = {}; // keyed by "FROM_TO", each with { rate, expiry }

async function getExchangeRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1;

  const key = `${fromCurrency}_${toCurrency}`;
  const cached = rateCache[key];
  if (cached && Date.now() < cached.expiry) {
    return cached.rate;
  }

  try {
    const response = await fetch(`https://api.frankfurter.dev/v1/latest?base=${fromCurrency}&symbols=${toCurrency}`);
    if (!response.ok) throw new Error(`Rate fetch failed: ${response.status}`);

    const data = await response.json();
    const rate = data.rates?.[toCurrency];
    if (!rate) throw new Error(`${toCurrency} rate missing from response`);

    rateCache[key] = { rate, expiry: Date.now() + 12 * 60 * 60 * 1000 }; // 12 hours
    return rate;
  } catch (err) {
    console.error(`Exchange rate fetch failed for ${fromCurrency}->${toCurrency}:`, err.message);
    return null; // caller decides how to handle a missing rate
  }
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

async function computeValuation(listings, condition, targetCurrency) {
  const multiplier = CONDITION_MULTIPLIER[condition] ?? 0.85;

  if (!listings.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      currency: targetCurrency,
      lowConfidence: true,
      reasoning: "No comparable listings found on eBay for this item right now. Try a more specific or more common name for it.",
      comps: []
    };
  }

  // Convert every listing to the target currency FIRST, using its own native
  // currency — mixing unconverted USD and GBP numbers together would silently
  // corrupt the median/outlier math below.
  const uniqueCurrencies = [...new Set(listings.map(l => l.price?.currency).filter(Boolean))];
  const rates = {};
  for (const cur of uniqueCurrencies) {
    rates[cur] = await getExchangeRate(cur, targetCurrency);
  }

  const converted = listings
    .map(l => {
      const raw = parseFloat(l.price?.value);
      const cur = l.price?.currency;
      const rate = rates[cur];
      if (isNaN(raw) || raw <= 0 || !rate) return null;
      return { ...l, convertedPrice: raw * rate };
    })
    .filter(Boolean);

  if (!converted.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      currency: targetCurrency,
      lowConfidence: true,
      reasoning: "Found listings but couldn't convert their pricing.",
      comps: []
    };
  }

  const sortedPrices = converted.map(l => l.convertedPrice).sort((a, b) => a - b);

  // Reject outliers relative to the median rather than trimming by list position —
  // this handles a cluster of misfiled/junk listings (e.g. a page of $1 accessories)
  // that would otherwise anchor the low end no matter how they're sorted.
  const med = median(sortedPrices);
  const usablePrices = sortedPrices.filter(p => p >= med * 0.4 && p <= med * 2.5);
  const prices = usablePrices.length >= 3 ? usablePrices : sortedPrices;

  const low = prices[0];
  const high = prices[prices.length - 1];
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;

  const comps = converted
    .filter(l => l.convertedPrice >= med * 0.4 && l.convertedPrice <= med * 2.5)
    .slice(0, 3)
    .map(l => ({
      source: `eBay listing — ${l.condition || 'condition unspecified'}`,
      price: money(l.convertedPrice, targetCurrency)
    }));

  // Thin sample size means the estimate could easily be one mismatched listing —
  // surface that honestly instead of presenting it with full confidence.
  const lowConfidence = prices.length < 3;

  return {
    low: Math.round(low * multiplier),
    high: Math.round(high * multiplier),
    best_guess: Math.round(avg * multiplier),
    currency: targetCurrency,
    lowConfidence,
    reasoning: lowConfidence
      ? `Only ${prices.length} comparable eBay listing${prices.length === 1 ? '' : 's'} found for this item — treat this estimate as rough, not reliable.`
      : `Based on ${prices.length} comparable eBay listings (of ${listings.length} found) for similar items, adjusted for "${condition}" condition. These reflect current asking prices, not confirmed sold prices.`,
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
    let listings = await searchMultipleMarketplaces(item, token, categoryId);

    // If the category guess was wrong or too narrow and returned nothing, retry unfiltered
    if (listings.length === 0 && categoryId) {
      listings = await searchMultipleMarketplaces(item, token, null);
    }

    const currency = getCurrencyForRequest(req);
    const result = await computeValuation(listings, condition, currency);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Appraisal failed', detail: String(err.message || err) });
  }
}