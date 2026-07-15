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

// Country -> currency + readable name for common markets. Falls back to USD
// for anything not listed. The name is used in the AI-search fallback prompt below.
const COUNTRY_INFO = {
  ZA: { currency: 'ZAR', name: 'South Africa' }, US: { currency: 'USD', name: 'United States' },
  GB: { currency: 'GBP', name: 'United Kingdom' }, IE: { currency: 'EUR', name: 'Ireland' },
  DE: { currency: 'EUR', name: 'Germany' }, FR: { currency: 'EUR', name: 'France' },
  ES: { currency: 'EUR', name: 'Spain' }, IT: { currency: 'EUR', name: 'Italy' },
  NL: { currency: 'EUR', name: 'Netherlands' }, PT: { currency: 'EUR', name: 'Portugal' },
  BE: { currency: 'EUR', name: 'Belgium' }, AT: { currency: 'EUR', name: 'Austria' },
  FI: { currency: 'EUR', name: 'Finland' }, GR: { currency: 'EUR', name: 'Greece' },
  CA: { currency: 'CAD', name: 'Canada' }, AU: { currency: 'AUD', name: 'Australia' },
  NZ: { currency: 'NZD', name: 'New Zealand' }, JP: { currency: 'JPY', name: 'Japan' },
  CN: { currency: 'CNY', name: 'China' }, IN: { currency: 'INR', name: 'India' },
  BR: { currency: 'BRL', name: 'Brazil' }, MX: { currency: 'MXN', name: 'Mexico' },
  AR: { currency: 'ARS', name: 'Argentina' }, CH: { currency: 'CHF', name: 'Switzerland' },
  SE: { currency: 'SEK', name: 'Sweden' }, NO: { currency: 'NOK', name: 'Norway' },
  DK: { currency: 'DKK', name: 'Denmark' }, KE: { currency: 'KES', name: 'Kenya' },
  NG: { currency: 'NGN', name: 'Nigeria' }, GH: { currency: 'GHS', name: 'Ghana' },
  EG: { currency: 'EGP', name: 'Egypt' }, MA: { currency: 'MAD', name: 'Morocco' },
  AE: { currency: 'AED', name: 'United Arab Emirates' }, SA: { currency: 'SAR', name: 'Saudi Arabia' },
  IL: { currency: 'ILS', name: 'Israel' }, TR: { currency: 'TRY', name: 'Turkey' },
  SG: { currency: 'SGD', name: 'Singapore' }, HK: { currency: 'HKD', name: 'Hong Kong' },
  KR: { currency: 'KRW', name: 'South Korea' }, TH: { currency: 'THB', name: 'Thailand' },
  MY: { currency: 'MYR', name: 'Malaysia' }, PH: { currency: 'PHP', name: 'Philippines' },
  ID: { currency: 'IDR', name: 'Indonesia' }, VN: { currency: 'VND', name: 'Vietnam' },
  PL: { currency: 'PLN', name: 'Poland' }, CZ: { currency: 'CZK', name: 'Czechia' },
  HU: { currency: 'HUF', name: 'Hungary' }, RO: { currency: 'RON', name: 'Romania' }
};

function getRequestGeo(req) {
  const country = req.headers['x-vercel-ip-country'];
  const info = COUNTRY_INFO[country];
  return info || { currency: 'USD', name: 'United States' };
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

// Currency symbols/prefixes used to spot prices inside raw search text.
// Falls back to matching the plain ISO code (e.g. "NGN 50,000") for currencies
// without a clean ASCII symbol.
const CURRENCY_SYMBOL = {
  ZAR: 'R', USD: '\\$', GBP: '£', EUR: '€', INR: '₹', JPY: '¥', CNY: '¥',
  NGN: '₦', KES: 'KSh', GHS: 'GH₵', AUD: 'A\\$', CAD: 'C\\$', NZD: 'NZ\\$',
  BRL: 'R\\$', MXN: 'MX\\$', SGD: 'S\\$', HKD: 'HK\\$', KRW: '₩', THB: '฿',
  TRY: '₺', PLN: 'zł'
};

// Retail pages often show a monthly financing figure (e.g. "R400 p/m" via
// Mobicred/PayJustNow) right next to the real price — those need to be
// excluded, or a cluster of identical installment amounts can outweigh and
// bury the one correct number in the outlier-rejection step below.
const INSTALLMENT_CONTEXT = /p\/?m\b|\/\s*mo\b|per\s+month|instal?ment|deposit|mobicred|payjustnow|credit\s*line|x\s*\d+\s*(months?|mo)\b/i;

function extractPrices(text, currency) {
  if (!text) return [];
  const symbol = CURRENCY_SYMBOL[currency] || currency;
  // Matches "R1,234" / "R 1234.50" style, OR "1,234 ZAR" style — covers most
  // real-world price formatting without needing per-site custom parsing.
  const pattern = new RegExp(
    `(?:${symbol}\\s?([\\d][\\d,]*(?:\\.\\d+)?))|(?:([\\d][\\d,]*(?:\\.\\d+)?)\\s?${currency})`,
    'gi'
  );
  const matches = [...text.matchAll(pattern)];
  const prices = [];
  for (const m of matches) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    const value = parseFloat(raw.replace(/,/g, ''));
    if (isNaN(value) || value <= 10) continue; // filters stray small numbers (specs, ratings, etc.)

    const start = Math.max(0, m.index - 25);
    const end = Math.min(text.length, m.index + m[0].length + 25);
    if (INSTALLMENT_CONTEXT.test(text.slice(start, end))) continue; // skip monthly payment mentions

    prices.push(value);
  }
  return prices;
}

// eBay only really has US and UK marketplaces — for every other country, eBay's
// prices reflect demand in a market the seller isn't even selling into. This
// fallback uses Tavily (a search API, not an LLM) to pull real local pages,
// then extracts prices from the raw text ourselves — no per-request AI cost,
// works within Tavily's free tier (1,000 searches/month, no card required).
async function getLocalMarketAppraisal(item, condition, currency, countryName) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY not configured on the server yet');
  }

  const wantsNew = /mint|sealed|brand new|excellent/i.test(condition);
  const query = `${item} price ${countryName} ${wantsNew ? 'new' : 'used'}`;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      include_answer: true,
      max_results: 6
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Tavily search failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const multiplier = CONDITION_MULTIPLIER[condition] ?? 0.85;

  const answerPrices = extractPrices(data.answer, currency);

  // Collect each result's first extracted price alongside its source, but
  // don't decide which to DISPLAY as comps yet — that depends on the anchor,
  // which we don't have until after this loop.
  const resultCandidates = [];
  let resultPrices = [];
  for (const r of (data.results || [])) {
    const prices = extractPrices(r.content || r.title || '', currency);
    if (prices.length > 0) {
      let hostname = r.url;
      try { hostname = new URL(r.url).hostname.replace('www.', ''); } catch {}
      resultCandidates.push({ source: hostname, price: prices[0] });
    }
    resultPrices.push(...prices);
  }

  // Prefer the synthesized answer as the anchor — it's one coherent statement
  // about the item, not a grab-bag of numbers scraped from six different pages
  // (financing terms, unrelated products, accessories, etc.). Only keep
  // result-scraped prices that land reasonably close to that anchor.
  if (answerPrices.length > 0) {
    const anchor = median(answerPrices.slice().sort((a, b) => a - b));
    const nearby = resultPrices.filter(p => p >= anchor * 0.6 && p <= anchor * 1.6);
    const usable = [anchor, ...nearby];

    // Only show comps whose price actually informed the estimate — showing a
    // "comparable sale" that got excluded as noise would contradict the number
    // right above it.
    const comps = resultCandidates
      .filter(c => c.price >= anchor * 0.6 && c.price <= anchor * 1.6)
      .slice(0, 3)
      .map(c => ({ source: c.source, price: money(c.price, currency) }));

    const low = Math.min(...usable);
    const high = Math.max(...usable);
    const avg = usable.reduce((sum, p) => sum + p, 0) / usable.length;
    // A wide low/high spread is itself a sign the estimate can't be trusted,
    // even when multiple sources technically agree with each other.
    const spreadTooWide = low > 0 && (high / low) > 3;

    return {
      low: Math.round(low * multiplier),
      high: Math.round(high * multiplier),
      best_guess: Math.round(avg * multiplier),
      currency,
      lowConfidence: usable.length < 2 || spreadTooWide,
      reasoning: `Based on local pricing found via web search for ${countryName}, adjusted for "${condition}" condition.${data.answer ? ' ' + data.answer.slice(0, 200) : ''}`,
      comps
    };
  }

  // No usable price in the synthesized answer — fall back to the noisier
  // pooled-and-filtered approach using whatever result pages turned up.
  if (!resultPrices.length) {
    return {
      low: 0,
      high: 0,
      best_guess: 0,
      currency,
      lowConfidence: true,
      reasoning: `No local pricing found for ${countryName} via web search.${data.answer ? ' ' + data.answer.slice(0, 200) : ''}`,
      comps: []
    };
  }

  const sorted = resultPrices.slice().sort((a, b) => a - b);
  const med = median(sorted);
  const usable = sorted.filter(p => p >= med * 0.4 && p <= med * 2.5);
  const prices = usable.length >= 2 ? usable : sorted;

  const low = prices[0];
  const high = prices[prices.length - 1];
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  const lowConfidence = prices.length < 3;

  const fallbackComps = resultCandidates
    .filter(c => c.price >= med * 0.4 && c.price <= med * 2.5)
    .slice(0, 3)
    .map(c => ({ source: c.source, price: money(c.price, currency) }));

  return {
    low: Math.round(low * multiplier),
    high: Math.round(high * multiplier),
    best_guess: Math.round(avg * multiplier),
    currency,
    lowConfidence,
    reasoning: `Based on ${prices.length} local price${prices.length === 1 ? '' : 's'} found via web search for ${countryName}, adjusted for "${condition}" condition.${data.answer ? ' ' + data.answer.slice(0, 200) : ''}`,
    comps: fallbackComps
  };
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
  // A wide low/high spread is its own red flag too, even with enough listings.
  const spreadTooWide = low > 0 && (high / low) > 3;
  const lowConfidence = prices.length < 3 || spreadTooWide;

  return {
    low: Math.round(low * multiplier),
    high: Math.round(high * multiplier),
    best_guess: Math.round(avg * multiplier),
    currency: targetCurrency,
    lowConfidence,
    reasoning: prices.length < 3
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

  const { currency, name: countryName } = getRequestGeo(req);

  try {
    // eBay only meaningfully covers US/UK — everywhere else, use local-market
    // AI search instead, since eBay's numbers there would be systematically wrong,
    // not just noisy.
    if (currency !== 'USD' && currency !== 'GBP') {
      try {
        const result = await getLocalMarketAppraisal(item, condition, currency, countryName);
        res.status(200).json(result);
        return;
      } catch (err) {
        console.error(`Local market appraisal failed, falling back to eBay US/UK data:`, err.message);
        // Fall through to eBay below — worse data is better than a broken app,
        // but we mark it low-confidence since eBay isn't a good proxy here.
      }
    }

    const token = await getEbayToken();
    const categoryId = await getBestCategory(item, token);
    let listings = await searchMultipleMarketplaces(item, token, categoryId);

    // If the category guess was wrong or too narrow and returned nothing, retry unfiltered
    if (listings.length === 0 && categoryId) {
      listings = await searchMultipleMarketplaces(item, token, null);
    }

    const result = await computeValuation(listings, condition, currency);

    // If we fell through from a failed local-market attempt, be explicit that
    // this is a weaker proxy than usual.
    if (currency !== 'USD' && currency !== 'GBP') {
      result.lowConfidence = true;
      result.reasoning = `${result.reasoning} Note: based on US/UK eBay pricing, not local ${countryName} market data — treat as a rough reference only.`;
    }

    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Appraisal failed', detail: String(err.message || err) });
  }
}