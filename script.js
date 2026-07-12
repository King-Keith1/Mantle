document.getElementById('dateTag').textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });

  let selectedCondition = 'Mint / sealed, never used';
  document.querySelectorAll('.cond-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cond-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCondition = btn.dataset.cond;
    });
  });

  const appraiseBtn = document.getElementById('appraiseBtn');
  const spinner = document.getElementById('spinner');
  const btnText = document.getElementById('btnText');
  const errorBox = document.getElementById('errorBox');
  const resultBox = document.getElementById('resultBox');

  async function getAppraisal() {
    const item = document.getElementById('itemName').value.trim();
    const age = document.getElementById('itemAge').value;
    const category = document.getElementById('itemCategory').value;

    errorBox.style.display = 'none';
    resultBox.style.display = 'none';

    if (!item) {
      errorBox.textContent = 'Tell us what the item is first.';
      errorBox.style.display = 'block';
      return;
    }

    appraiseBtn.disabled = true;
    spinner.classList.add('show');
    btnText.textContent = 'Checking eBay comps…';

    try {
      const response = await fetch("/api/appraise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item, category, age, condition: selectedCondition })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || ('Request failed: ' + response.status));
      }

      const result = await response.json();

      if (result.best_guess === 0 && (!result.comps || result.comps.length === 0)) {
        errorBox.textContent = result.reasoning || "Couldn't find comparable listings for that item — try a more specific or more common name.";
        errorBox.style.display = 'block';
        return;
      }

      renderResult(result);

    } catch (err) {
      console.error(err);
      errorBox.textContent = "Couldn't complete the appraisal — try again in a moment.";
      errorBox.style.display = 'block';
    } finally {
      appraiseBtn.disabled = false;
      spinner.classList.remove('show');
      btnText.textContent = 'Get appraisal';
    }
  }

  let currentAppraisal = null; // holds the last appraisal result + inputs, ready to save
  let sessionCurrency = 'USD'; // set from the first appraisal response, reused for Vault totals

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

  function renderResult(r) {
    sessionCurrency = r.currency || 'USD';
    const fmt = n => money(n, sessionCurrency);

    document.getElementById('valueStamp').textContent = fmt(r.best_guess);
    document.getElementById('valueRange').textContent = `Range: ${fmt(r.low)} – ${fmt(r.high)}`;
    document.getElementById('reasoning').textContent = r.reasoning || '';

    const resultLabel = document.querySelector('.result-label');
    const existingBadge = resultLabel.querySelector('.low-confidence-badge');
    if (existingBadge) existingBadge.remove();
    if (r.lowConfidence) {
      const badge = document.createElement('span');
      badge.className = 'low-confidence-badge';
      badge.textContent = ' · Low confidence';
      resultLabel.appendChild(badge);
    }

    const compsSection = document.getElementById('compsSection');
    const compsList = document.getElementById('compsList');
    compsList.innerHTML = '';

    if (r.comps && r.comps.length > 0) {
      compsSection.style.display = 'block';
      r.comps.forEach(c => {
        const div = document.createElement('div');
        div.className = 'comp-item';
        div.innerHTML = `<span class="comp-source">${c.source}</span><span class="comp-price">${c.price}</span>`;
        compsList.appendChild(div);
      });
    } else {
      compsSection.style.display = 'none';
    }

    resultBox.style.display = 'block';

    // stash this appraisal so "Save to Vault" has something to save
    currentAppraisal = {
      name: document.getElementById('itemName').value.trim(),
      category: document.getElementById('itemCategory').selectedOptions[0].textContent,
      value: r.best_guess
    };
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to Vault';
  }

  // --- VAULT ---
  const vault = []; // in-memory only — no backend, resets on refresh

  function renderVault() {
    const total = vault.reduce((sum, v) => sum + v.value, 0);
    document.getElementById('vaultTotal').textContent = money(total, sessionCurrency);
    document.getElementById('vaultCount').textContent = vault.length;

    const catsWrap = document.getElementById('vaultCategories');
    const itemsWrap = document.getElementById('vaultItems');

    if (vault.length === 0) {
      catsWrap.style.display = 'none';
      itemsWrap.innerHTML = '<div class="vault-empty" id="vaultEmpty">Nothing in your Vault yet.<br>Get an appraisal above, then save it — this is where your collection adds up.</div>';
      return;
    }

    // category breakdown
    const catTotals = {};
    vault.forEach(v => { catTotals[v.category] = (catTotals[v.category] || 0) + v.value; });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 4);

    catsWrap.style.display = 'flex';
    catsWrap.innerHTML = topCats.map(([cat, val]) =>
      `<span class="cat-chip">${cat} <b>${money(val, sessionCurrency)}</b></span>`
    ).join('');

    // item list, most recent first
    itemsWrap.innerHTML = [...vault].reverse().map(v => `
      <div class="vault-item-row">
        <div>
          <div class="vault-item-name">${v.name}</div>
          <div class="vault-item-meta">${v.category}</div>
        </div>
        <div class="vault-item-price">${money(v.value, sessionCurrency)}</div>
      </div>
    `).join('');
  }

  document.getElementById('saveBtn').addEventListener('click', () => {
    if (!currentAppraisal) return;
    vault.push(currentAppraisal);
    renderVault();

    const saveBtn = document.getElementById('saveBtn');
    saveBtn.textContent = 'Saved ✓';
    saveBtn.disabled = true;

    // gentle scroll to the vault so the growth is felt, not just implied
    document.querySelector('.vault-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  appraiseBtn.addEventListener('click', getAppraisal);
  document.getElementById('itemName').addEventListener('keydown', e => {
    if (e.key === 'Enter') getAppraisal();
  });