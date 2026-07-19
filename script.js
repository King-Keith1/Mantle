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
      document.getElementById('compsTitle').textContent = 'Comparable sales found';
      r.comps.forEach(c => {
        const div = document.createElement('div');
        div.className = 'comp-item';
        div.innerHTML = `<span class="comp-source">${c.source}</span><span class="comp-price">${c.price}</span>`;
        compsList.appendChild(div);
      });
    } else if (r.best_guess > 0) {
      // We have an estimate, just no individual listings solid enough to show —
      // say so explicitly rather than letting the section silently vanish.
      compsSection.style.display = 'block';
      document.getElementById('compsTitle').textContent = 'Comparable sales';
      const div = document.createElement('div');
      div.className = 'comp-empty-note';
      div.textContent = "No individual listings matched closely enough to show as evidence — this figure is a single synthesized estimate, treat it as rougher than usual.";
      compsList.appendChild(div);
    } else {
      compsSection.style.display = 'none';
    }

    resultBox.style.display = 'block';

    // stash this appraisal so "Save to Vault" has something to save
    currentAppraisal = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: document.getElementById('itemName').value.trim(),
      category: document.getElementById('itemCategory').selectedOptions[0].textContent,
      value: r.best_guess
    };
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to Vault';
  }

  // --- SUPABASE SETUP ---
  const SUPABASE_URL = 'https://fkudalwfgapwkaucfobg.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_Ou5xiZ_EEwyWs-fzD3F_5Q_oFkfWn7F';
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const authCard = document.getElementById('authCard');
  const vaultCard = document.getElementById('vaultCard');
  const authEmailInput = document.getElementById('authEmail');
  const sendMagicLinkBtn = document.getElementById('sendMagicLinkBtn');
  const authStatus = document.getElementById('authStatus');
  const vaultUserEmail = document.getElementById('vaultUserEmail');
  const signOutBtn = document.getElementById('signOutBtn');

  let currentSession = null;

  function setAuthStatus(text, type) {
    authStatus.textContent = text;
    authStatus.className = 'auth-status' + (type ? ' ' + type : '');
  }

  sendMagicLinkBtn.addEventListener('click', async () => {
    const email = authEmailInput.value.trim();
    if (!email || !email.includes('@')) {
      setAuthStatus('Enter a valid email first.', 'error');
      return;
    }

    // If there's an appraisal on screen when someone decides to sign in,
    // remember it so it can be saved automatically once they're back and verified —
    // otherwise the whole point of signing in mid-flow gets lost on the redirect.
    if (currentAppraisal) {
      localStorage.setItem('pendingVaultItem', JSON.stringify(currentAppraisal));
    }

    sendMagicLinkBtn.disabled = true;
    setAuthStatus('Sending…');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });

    sendMagicLinkBtn.disabled = false;

    if (error) {
      setAuthStatus("Couldn't send the link — try again.", 'error');
      console.error(error);
    } else {
      setAuthStatus('Check your email for a sign-in link.', 'success');
    }
  });

  signOutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    if (session) {
      authCard.style.display = 'none';
      vaultCard.style.display = 'block';
      vaultUserEmail.textContent = session.user.email;
      loadVaultFromDb();
    } else {
      authCard.style.display = 'block';
      vaultCard.style.display = 'none';
    }
  });

  async function loadVaultFromDb() {
    const { data, error } = await supabase
      .from('vault_items')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to load vault:', error);
      return;
    }

    renderVault(data || []);

    // If we arrived here via a magic-link redirect with a pending item waiting
    // to be saved, save it now that we have a real session.
    const pending = localStorage.getItem('pendingVaultItem');
    if (pending) {
      localStorage.removeItem('pendingVaultItem');
      try {
        await saveItemToDb(JSON.parse(pending));
      } catch (err) {
        console.error('Failed to save pending item:', err);
      }
    }
  }

  async function saveItemToDb(item) {
    const { error } = await supabase.from('vault_items').insert({
      user_id: currentSession.user.id,
      name: item.name,
      category: item.category,
      value: item.value,
      currency: sessionCurrency
    });
    if (error) throw error;
    await loadVaultFromDb();
  }

  function renderVault(items) {
    const total = items.reduce((sum, v) => sum + Number(v.value), 0);
    document.getElementById('vaultTotal').textContent = money(total, sessionCurrency);
    document.getElementById('vaultCount').textContent = items.length;

    const catsWrap = document.getElementById('vaultCategories');
    const itemsWrap = document.getElementById('vaultItems');

    if (items.length === 0) {
      catsWrap.style.display = 'none';
      itemsWrap.innerHTML = '<div class="vault-empty" id="vaultEmpty">Nothing in your Vault yet.<br>Get an appraisal above, then save it — this is where your collection adds up.</div>';
      return;
    }

    // category breakdown
    const catTotals = {};
    items.forEach(v => { catTotals[v.category] = (catTotals[v.category] || 0) + Number(v.value); });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 4);

    catsWrap.style.display = 'flex';
    catsWrap.innerHTML = topCats.map(([cat, val]) =>
      `<span class="cat-chip">${cat} <b>${money(val, sessionCurrency)}</b></span>`
    ).join('');

    // item list, most recent first
    itemsWrap.innerHTML = [...items].reverse().map(v => `
      <div class="vault-item-row" data-id="${v.id}">
        <div>
          <div class="vault-item-name">${v.name}</div>
          <div class="vault-item-meta">${v.category}</div>
        </div>
        <div class="vault-item-right">
          <div class="vault-item-price">${money(Number(v.value), sessionCurrency)}</div>
          <button class="vault-remove-btn" data-id="${v.id}" aria-label="Remove ${v.name}">✕</button>
        </div>
      </div>
    `).join('');

    itemsWrap.querySelectorAll('.vault-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const { error } = await supabase.from('vault_items').delete().eq('id', id);
        if (error) {
          console.error('Failed to remove item:', error);
          return;
        }
        loadVaultFromDb();
      });
    });
  }

  document.getElementById('saveBtn').addEventListener('click', async () => {
    if (!currentAppraisal) return;
    const saveBtn = document.getElementById('saveBtn');

    if (!currentSession) {
      // Not signed in — scroll to the sign-in prompt instead of silently failing.
      document.querySelector('.vault-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
      authEmailInput.focus();
      setAuthStatus('Sign in to save this item — it\'ll be added automatically once you do.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      await saveItemToDb(currentAppraisal);
      saveBtn.textContent = 'Saved ✓';
      document.querySelector('.vault-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error('Failed to save:', err);
      saveBtn.textContent = 'Save to Vault';
      saveBtn.disabled = false;
    }
  });

  appraiseBtn.addEventListener('click', getAppraisal);
  document.getElementById('itemName').addEventListener('keydown', e => {
    if (e.key === 'Enter') getAppraisal();
  });