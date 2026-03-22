// ── API Configuration ──
// NOTE: For different devices to work, replace 'localhost' with your server's LAN IP or a hosted URL.
const API_URL = 'http://localhost:3000/api';

// ── State ──
let userId = null, scanHistory = [], fileQueue = [], currentResults = [], isScanning = false;
let currentUser = JSON.parse(localStorage.getItem('scaniq_user') || 'null');
let authToken = localStorage.getItem('scaniq_token') || null;

// ── DOM ──
const $ = id => document.getElementById(id);

// ── Auth Flow ──
async function initAuth() {
    if (authToken && authToken !== 'null') {
        try {
            await fetchHistory();
            showApp();
        } catch (e) {
            console.error('Session expired or server offline');
            logout();
        }
    } else {
        showAuth();
    }
    hideLoading();
}

function hideLoading() {
    const ls = $('loadingScreen');
    if (ls) {
        ls.classList.add('fade');
        setTimeout(() => ls.style.display = 'none', 500);
    }
}

function showAuth() {
    $('authPage').classList.add('show');
    $('appPage').classList.remove('show');
}

function showApp() {
    $('authPage').classList.remove('show');
    $('appPage').classList.add('show');
    $('navUser').textContent = currentUser?.name || 'User';
    setSyncLive(true);
}

function setSyncLive(live) {
    const dot = $('syncDot');
    const label = $('syncLabel');
    if (dot) dot.className = 'sync-dot' + (live ? ' live' : '');
    if (label) label.textContent = live ? 'Cloud Sync' : 'Offline';
}

// ── Auth Actions ──
$('signinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const email = $('siEmail').value.trim(), password = $('siPassword').value;

    try {
        btn.disabled = true; btn.textContent = 'Signing in...';
        const res = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        localStorage.setItem('scaniq_token', data.token);
        localStorage.setItem('scaniq_user', JSON.stringify(data.user));
        authToken = data.token;
        currentUser = data.user;
        
        await fetchHistory();
        showApp();
        showToast('✅', `Welcome back, ${data.user.name}!`);
    } catch (err) {
        showError('siError', err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Sign In →';
    }
});

$('signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const name = $('suName').value.trim(), email = $('suEmail').value.trim();
    const password = $('suPassword').value, confirm = $('suConfirm').value;

    if (password !== confirm) { showError('suError', 'Passwords do not match.'); return; }
    if (password.length < 6) { showError('suError', 'Password must be at least 6 characters.'); return; }

    try {
        btn.disabled = true; btn.textContent = 'Creating account...';
        const res = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Signup failed');

        localStorage.setItem('scaniq_token', data.token);
        localStorage.setItem('scaniq_user', JSON.stringify(data.user));
        authToken = data.token;
        currentUser = data.user;

        await fetchHistory();
        showApp();
        showToast('✅', `Account created! Welcome, ${name}!`);
    } catch (err) {
        showError('suError', err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Create Account →';
    }
});

$('goSignup').addEventListener('click', e => {
    e.preventDefault();
    $('signinCard').classList.add('hidden');
    $('signupCard').classList.remove('hidden');
});

$('goSignin').addEventListener('click', e => {
    e.preventDefault();
    $('signupCard').classList.add('hidden');
    $('signinCard').classList.remove('hidden');
});

function logout() {
    localStorage.removeItem('scaniq_token');
    localStorage.removeItem('scaniq_user');
    authToken = null;
    currentUser = null;
    scanHistory = [];
    renderHistory();
    showAuth();
    showToast('↪', 'Signed out.');
}

$('logoutBtn').addEventListener('click', logout);

function showError(id, msg) {
    const el = $(id);
    el.textContent = '⚠ ' + msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4000);
}

// ── PDF.js Local Extraction ──
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function extractTextFromPDF(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const items = content.items.filter(it => it.str && it.str.trim());
        if (!items.length) continue;
        items.sort((a, b) => {
            const diff = b.transform[5] - a.transform[5];
            if (Math.abs(diff) > 3) return diff;
            return a.transform[4] - b.transform[4];
        });
        const lineGroups = [];
        let curGroup = [items[0]], curY = items[0].transform[5];
        for (let j = 1; j < items.length; j++) {
            const it = items[j], iy = it.transform[5];
            const h = Math.max(it.height || 5, curGroup[0].height || 5, 5);
            if (Math.abs(iy - curY) <= h * 0.6) curGroup.push(it);
            else { lineGroups.push(curGroup); curGroup = [it]; curY = iy; }
        }
        lineGroups.push(curGroup);
        fullText += lineGroups.map(g => g.sort((a, b) => a.transform[4] - b.transform[4]).map(it => it.str).join(' ').trim()).join('\n') + '\n---PAGE_BREAK---\n';
    }
    const cleanText = fullText.replace(/\s+/g, '').replace(/---PAGE_BREAK---/g, '').trim();
    if (cleanText.length < 20) {
        const pl = $('progLabel');
        fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i), vp = page.getViewport({ scale: 2.5 }), canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            const { data } = await Tesseract.recognize(canvas, 'eng', { logger: m => { if (m.status === 'recognizing text' && pl) pl.textContent = `OCR page ${i}/${pdf.numPages} — ${Math.round((m.progress || 0) * 100)}%`; } });
            fullText += data.text + '\n---PAGE_BREAK---\n';
        }
    }
    return fullText;
}

function extractOrderData(text) {
    if (/amazon|asspl|aripl|\d{3}-\d{7}-\d{7}/i.test(text)) text = text.split('---PAGE_BREAK---')[0];
    else text = text.replace(/---PAGE_BREAK---/g, '\n');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const findInLines = (patterns, skipRx = null) => {
        for (const line of lines) { if (skipRx && skipRx.test(line)) continue; for (const p of patterns) { p.lastIndex = 0; const m = p.exec(line); if (m && m[1]) return m[1].trim(); } }
        return null;
    };
    const findLabelVal = (labelRxArr, valRx) => {
        for (let i = 0; i < lines.length; i++) {
            for (const lp of labelRxArr) {
                lp.lastIndex = 0;
                if (lp.test(lines[i])) {
                    const vp = new RegExp(lp.source + '[\\s:.#=-]*(' + valRx.source + ')', 'i'), m = vp.exec(lines[i]);
                    if (m && m[1]) return m[1].trim();
                    if (i + 1 < lines.length && valRx.test(lines[i + 1])) return lines[i + 1].match(valRx)[0];
                }
            }
        }
        return null;
    };
    let orderNo = findInLines([/order\s*(?:no|number|id|#)[.\s:=#-]*([A-Za-z0-9][\w\-]{3,35})/i, /(\d{3}-\d{7}-\d{7})/, /\b(OD\d{10,})\b/]);
    let sku = findInLines([/\b([A-Z]{2}-\d{3,10}(?:-[A-Z0-9]{1,10})?)\b/], /invoice|order|date|hsn|tel|dated/i);
    if (!sku) sku = findLabelVal([/\bsku\b/i, /item\s*code/i], /[A-Z0-9][A-Z0-9\-\/]{1,25}/i);

    const floatRx = /\b(\d[\d,]*)(?:\.\d{1,2})?\b/g;
    let amounts = [];
    lines.forEach((line, i) => {
        if (/(discount|save|saved|shipping|cgst|sgst|igst|tax|rate|qty)/i.test(line) && !/total/i.test(line)) return;
        let m; while ((m = floatRx.exec(line)) !== null) { let v = parseFloat(m[1].replace(/,/g, '')); if (v > 10 || line.toLowerCase().includes('total')) amounts.push({ val: v, line, index: i }); }
    });
    let finalAmount = null;
    const strongRx = /\b(?:grand\s*total|total\s*invoice\s*value|invoice\s*value|total\s*payable|amount\s*payable|total\s*amount)\b/i;
    const strictLabel = amounts.slice().reverse().find(a => strongRx.test(a.line) || (a.index > 0 && strongRx.test(lines[a.index - 1])));
    if (strictLabel) finalAmount = strictLabel.val;
    if (!finalAmount) {
        const totalLabel = amounts.slice().reverse().find(a => (/\btotal\b/i.test(a.line) || (a.index > 0 && /\btotal\b/i.test(lines[a.index - 1]))) && !/sub[ -]?total/i.test(a.line));
        if (totalLabel) finalAmount = totalLabel.val;
    }
    if (!finalAmount && amounts.length > 0) finalAmount = Math.max(...amounts.map(a => a.val));

    const tLabels = [/awb/i, /tracking/i, /packet\s*id/i, /waybill/i, /shipment/i];
    const tParts = [], tSeen = new Set();
    lines.forEach((line, i) => {
        tLabels.forEach(rx => {
            if (rx.test(line)) {
                const vp = new RegExp(rx.source + '[\\s:.#=-]*([A-Za-z0-9][\\w\\-]{3,34})', 'i'), m = vp.exec(line);
                if (m && m[1] && !tSeen.has(m[1])) { tSeen.add(m[1]); tParts.push(m[1]); }
                else if (i + 1 < lines.length && /^[A-Za-z0-9][\w\-]{3,34}$/i.test(lines[i + 1]) && !tSeen.has(lines[i + 1])) { tSeen.add(lines[i + 1]); tParts.push(lines[i + 1]); }
            }
        });
    });
    return { order_no: orderNo, sku, total_amount: finalAmount ? '₹' + finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : null, tracking_no: tParts.join(' | ') || null };
}

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        $('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// ── File Queue ──
const dropZone = $('dropZone'), fileInput = $('fileInput');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); addFiles([...e.dataTransfer.files].filter(f => f.type === 'application/pdf')); });
fileInput.addEventListener('change', e => { addFiles([...e.target.files]); fileInput.value = ''; });
$('clearQueueBtn').addEventListener('click', () => { fileQueue = fileQueue.filter(q => q.status === 'processing'); renderQueue(); updateScanBtn(); });
$('scanBtn').addEventListener('click', startScan);

function addFiles(files) {
    files.forEach(f => { if (!fileQueue.find(q => q.file.name === f.name && q.status === 'pending')) fileQueue.push({ id: Date.now() + Math.random(), file: f, status: 'pending' }); });
    renderQueue(); updateScanBtn();
}
function updateScanBtn() { $('scanBtn').disabled = fileQueue.filter(q => q.status === 'pending').length === 0 || isScanning; }
function renderQueue() {
    const wrap = $('queueWrap'); if (!fileQueue.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block'; $('queueCount').textContent = fileQueue.length;
    $('queueList').innerHTML = fileQueue.map(q => {
        const icon = { pending: '⏳', processing: '🔄', done: '✅', error: '❌' }[q.status];
        const cls = `q-item ${q.status}`;
        const rm = q.status !== 'processing' ? `<button class="q-remove" data-id="${q.id}">✕</button>` : '';
        return `<div class="${cls}"><span class="q-status">${icon}</span><span class="q-name">${q.file.name}</span><span class="q-size">${(q.file.size / 1024).toFixed(1)} KB</span>${rm}</div>`;
    }).join('');
    document.querySelectorAll('.q-remove').forEach(btn => { btn.onclick = () => { fileQueue = fileQueue.filter(q => q.id !== parseFloat(btn.dataset.id)); renderQueue(); updateScanBtn(); }; });
}

async function startScan() {
    const pending = fileQueue.filter(q => q.status === 'pending'); if (!pending.length || isScanning) return;
    isScanning = true; currentResults = []; $('scanBtn').disabled = true; $('scanBtnText').textContent = 'Scanning...';
    $('scanProgress').classList.add('show'); $('errorAlert').classList.remove('show');
    const total = pending.length; let done = 0;
    for (const item of pending) {
        item.status = 'processing'; renderQueue();
        $('progLabel').textContent = `Scanning: ${item.file.name}`; $('progFrac').textContent = `${done + 1} / ${total}`;
        $('progBar').style.width = ((done / total) * 100) + '%';
        try {
            const text = await extractTextFromPDF(item.file), data = extractOrderData(text);
            item.status = 'done'; currentResults.push({ ...data, _file: item.file.name });
            await addToHistory(data, item.file.name);
        } catch (e) {
            item.status = 'error'; console.error(e); $('errorAlert').classList.add('show'); $('errorText').textContent = `Error: ${e.message}`;
        }
        done++; renderQueue(); $('progBar').style.width = ((done / total) * 100) + '%'; $('progFrac').textContent = `${done} / ${total}`;
    }
    isScanning = false; $('scanProgress').classList.remove('show'); $('scanBtnText').textContent = 'Scan All PDFs';
    updateScanBtn(); renderResults();
    if (currentResults.length > 0) {
        $('resultsBadge').classList.remove('hidden'); $('resultsBadge').textContent = currentResults.length;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector('[data-tab="results"]').classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        $('tab-results').classList.add('active');
    }
}

function renderResults() {
    $('resCount').textContent = currentResults.length + (currentResults.length === 1 ? ' entry' : ' entries');
    if (!currentResults.length) { $('resEmpty').style.display = 'block'; $('resTable').style.display = 'none'; return; }
    $('resEmpty').style.display = 'none'; $('resTable').style.display = 'table';
    $('resBody').innerHTML = currentResults.map((e, i) => `<tr><td>${i + 1}</td><td>${e._file}</td><td>${e.order_no || '—'}</td><td>${e.sku || '—'}</td><td>${e.total_amount || '—'}</td><td>${e.tracking_no || '—'}</td></tr>`).join('');
}

// ── Backend Fetch Actions ──
async function fetchHistory() {
    if (!authToken || authToken === 'null') return;
    const res = await fetch(`${API_URL}/history`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch history');
    scanHistory = data;
    renderHistory();
}

async function addToHistory(data, filename) {
    const now = new Date();
    const entry = {
        file: filename, order_no: data.order_no || null, sku: data.sku || null,
        total_amount: data.total_amount || null, tracking_no: data.tracking_no || null,
        scanned_at: now.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        date_iso: now.toISOString().slice(0, 10), timestamp: Date.now()
    };
    await fetch(`${API_URL}/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(entry)
    });
    fetchHistory();
}

function renderHistory() {
    $('histCount').textContent = scanHistory.length + (scanHistory.length === 1 ? ' entry' : ' entries');
    if (!scanHistory.length) { $('histEmpty').style.display = 'block'; $('histTable').style.display = 'none'; return; }
    $('histEmpty').style.display = 'none'; $('histTable').style.display = 'table';
    $('histBody').innerHTML = scanHistory.map((e, i) => {
        const found = [e.order_no, e.sku, e.total_amount, e.tracking_no].filter(Boolean).length;
        const badge = found === 4 ? `<span class="td-badge ok">✓ Complete</span>` : `<span class="td-badge partial">⚡ ${found}/4</span>`;
        return `<tr><td style="color:var(--t3)">${i+1}</td><td>${e.file}</td><td>${e.order_no||'—'}</td><td>${e.sku||'—'}</td><td>${e.total_amount||'—'}</td><td>${e.tracking_no||'—'}</td><td>${badge}</td><td style="color:var(--t3)">${e.scanned_at||''}</td></tr>`;
    }).join('');
}

$('clearHistBtn').addEventListener('click', async () => {
    if (!scanHistory.length || !confirm('Clear all history?')) return;
    await fetch(`${API_URL}/history`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
    showToast('🗑', 'History cleared.');
    fetchHistory();
});

// ── Export/Utility ──
$('exportBtn').addEventListener('click', () => {
    if (!scanHistory.length) return showToast('⚠', 'No data to export.');
    $('exportModal').classList.add('open');
});
$('modalCloseBtn').addEventListener('click', () => $('exportModal').classList.remove('open'));
$('modalExportBtn').addEventListener('click', () => {
    const from = $('exportFrom').value, to = $('exportTo').value;
    const filtered = scanHistory.filter(e => !(from && e.date_iso < from) && !(to && e.date_iso > to));
    const rows = [['#', 'File', 'Order No', 'SKU', 'Total Amount', 'Tracking / AWB', 'Date']];
    filtered.forEach((e, i) => rows.push([i+1, e.file, e.order_no||'', e.sku||'', e.total_amount||'', e.tracking_no||'', e.scanned_at||'']));
    const ws = XLSX.utils.aoa_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ScanIQ');
    XLSX.writeFile(wb, `ScanIQ_Export.xlsx`);
    $('exportModal').classList.remove('open');
});

function showToast(icon, msg) {
    const t = $('toast');
    if (!t) return;
    $('toastIcon').textContent = icon; $('toastMsg').textContent = msg;
    t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Start App ──
initAuth();