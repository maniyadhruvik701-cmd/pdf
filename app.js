import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase, ref, push, set, remove, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js';

// ── Firebase ──
const app = initializeApp({
    apiKey: "AIzaSyArhH6sxuSTScHIYInm7CvE1BJGjLGao1k",
    authDomain: "pdf12345-fe823.firebaseapp.com",
    databaseURL: "https://pdf12345-fe823-default-rtdb.firebaseio.com",
    projectId: "pdf12345-fe823",
    storageBucket: "pdf12345-fe823.firebasestorage.app",
    messagingSenderId: "864295629112",
    appId: "1:864295629112:web:b71fe1635f1a8ab34991cd",
    measurementId: "G-Y9MNJ6Q0TX"

});
const auth = getAuth(app);
const db = getDatabase(app);
const analytics = getAnalytics(app);

// ── State ──
let uid = null, scanHistory = [], fileQueue = [], currentResults = [], isScanning = false, histUnsub = null;
let currentUser = null;

// ── DOM ──
const $ = id => document.getElementById(id);

// ── Firebase Auth ──
onAuthStateChanged(auth, async user => {
    if (user && !user.isAnonymous) {
        // User is signed in with email/password
        uid = user.uid;
        currentUser = { name: user.displayName, email: user.email };
        setSyncLive(true);
        listenHistory();
        hideLoading();
        showApp();
    } else {
        // Not logged in or just anonymous (show login screen)
        setSyncLive(true);
        hideLoading();
        showAuth();
    }
});

function hideLoading() {
    const ls = $('loadingScreen');
    ls.classList.add('fade');
    setTimeout(() => ls.style.display = 'none', 500);
}

function checkAuthFlow() {
    if (!currentUser) { showAuth(); return; }
    showApp();
}

function showAuth() {
    $('authPage').classList.add('show');
    $('appPage').classList.remove('show');
}

function showApp() {
    $('authPage').classList.remove('show');
    $('appPage').classList.add('show');
    $('navUser').textContent = currentUser?.name || 'User';
}

function setSyncLive(live) {
    $('syncDot').className = 'sync-dot' + (live ? ' live' : '');
    $('syncLabel').textContent = live ? 'Live Sync' : 'Offline';
}

// ── Firebase Auth (Sign In / Sign Up) ──
$('signinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const email = $('siEmail').value.trim(), pass = $('siPassword').value;

    try {
        btn.disabled = true; btn.textContent = 'Signing in...';
        await signInWithEmailAndPassword(auth, email, pass);
        showToast('✅', `Welcome back!`);
    } catch (err) {
        console.error(err);
        let msg = 'Invalid email or password.';
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') msg = 'Invalid email or password.';
        showError('siError', msg);
    } finally {
        btn.disabled = false; btn.textContent = 'Sign In →';
    }
});

$('signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const name = $('suName').value.trim(), email = $('suEmail').value.trim();
    const pass = $('suPassword').value, confirm = $('suConfirm').value;

    if (pass !== confirm) { showError('suError', 'Passwords do not match.'); return; }
    if (pass.length < 6) { showError('suError', 'Password must be at least 6 characters.'); return; }

    try {
        btn.disabled = true; btn.textContent = 'Creating account...';
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await updateProfile(cred.user, { displayName: name });
        showToast('✅', `Account created! Welcome, ${name}!`);
    } catch (err) {
        console.error(err);
        let msg = 'Failed to create account.';
        if (err.code === 'auth/email-already-in-use') msg = 'Email already registered.';
        showError('suError', msg);
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

$('logoutBtn').addEventListener('click', async () => {
    try {
        await signOut(auth);
        currentUser = null;
        if (histUnsub) { histUnsub(); histUnsub = null; }
        scanHistory = [];
        renderHistory();
        showAuth();
        showToast('↪', 'Signed out.');
    } catch (e) {
        showToast('⚠', 'Logout failed.');
    }
});

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

    // First try: direct text extraction
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
            if (Math.abs(iy - curY) <= h * 0.6) { curGroup.push(it); }
            else { lineGroups.push(curGroup); curGroup = [it]; curY = iy; }
        }
        lineGroups.push(curGroup);
        const pageLines = lineGroups.map(g => {
            g.sort((a, b) => a.transform[4] - b.transform[4]);
            return g.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        fullText += pageLines.join('\n') + '\n---PAGE_BREAK---\n';
    }

    // Check if meaningful text was extracted (at least 20 chars of real content)
    const cleanText = fullText.replace(/\s+/g, '').replace(/---PAGE_BREAK---/g, '').trim();
    if (cleanText.length < 20) {
        // Fallback: OCR using Tesseract.js (image-based PDF)
        console.log('PDF has no text layer — running OCR...');
        const pl = $('progLabel');
        if (pl) pl.textContent = 'OCR scanning (image PDF)...';
        fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const scale = 2.5; // ~300 DPI
            const vp = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            // Run OCR on canvas
            const { data } = await Tesseract.recognize(canvas, 'eng', {
                logger: m => { if (m.status === 'recognizing text' && pl) pl.textContent = `OCR page ${i}/${pdf.numPages} — ${Math.round((m.progress || 0) * 100)}%`; }
            });
            fullText += (data.text || '') + '\n---PAGE_BREAK---\n';
        }
    }

    console.log('=== EXTRACTED TEXT ===');
    console.log(fullText);
    console.log('=== END ===');
    return fullText;
}

function extractOrderData(text) {
    const isAmazon = /amazon|asspl|aripl|\d{3}-\d{7}-\d{7}/i.test(text);
    if (isAmazon) {
        text = text.split('---PAGE_BREAK---')[0];
    } else {
        // Normal handling: remove the page break markers
        text = text.replace(/---PAGE_BREAK---/g, '\n');
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const flat = lines.join(' ');
    // findInLines now takes an explicit skip pattern so we don't grab garbage
    function findInLines(patterns, skipRx = null) {
        for (const line of lines) {
            if (skipRx && skipRx.test(line)) continue;
            for (const p of patterns) { p.lastIndex = 0; const m = p.exec(line); if (m && m[1] && m[1].trim().length >= 2) return m[1].trim(); }
        }
        return null;
    }
    // Label on line, value on same or NEXT line
    function findLabelVal(labelRxArr, valRx) {
        for (let i = 0; i < lines.length; i++) {
            for (const lp of labelRxArr) {
                lp.lastIndex = 0;
                if (lp.test(lines[i])) {
                    const vp = new RegExp(lp.source + '[\\s:.#=-]*(' + valRx.source + ')', 'i');
                    const m = vp.exec(lines[i]);
                    if (m && m[1] && m[1].length >= 3) return m[1].trim();
                    if (i + 1 < lines.length) { const n = lines[i + 1].trim(); if (n.length >= 3 && valRx.test(n)) return n.match(valRx)[0]; }
                }
            }
        }
        return null;
    }

    // ═ ORDER NUMBER ═
    let orderNo = null;
    
    // 1. Check for specific known formats first (Amazon, Flipkart)
    const specificPatterns = [
        /(\d{3}-\d{7}-\d{7})/, // Amazon
        /\b(OD\d{10,})\b/,      // Flipkart
    ];
    
    for (const p of specificPatterns) {
        const m = p.exec(text);
        if (m) { orderNo = m[1]; break; }
    }

    // 2. Fallback to labeled search if not found
    if (!orderNo) {
        orderNo = findInLines([
            /order\s*(?:id|no|number|#)[.\s:=#-]*([A-Z0-9][A-Z0-9\-]{7,35})/i,
            /sub[\s-]?order[\s]*(?:no|id)?[.\s:=#-]*([A-Z0-9][A-Z0-9\-]{7,35})/i,
        ], /date|dated|day/i); // Explicitly skip lines with 'date'
    }

    if (!orderNo) orderNo = findLabelVal([/order\s*(?:no|number|id|#)?/i, /order\s*id/i], /[A-Z0-9][\w\-]{7,35}/i);
    if (!orderNo) orderNo = findInLines([/\b([A-Z]{2,4}\d{10,})\b/]);

    // ═ SKU ═
    let sku = findInLines([
        /\b([A-Z]{2}-\d{3,10}(?:-[A-Z0-9]{1,10})?)\b/, // Strictly letters first, then hyphen, then digits (JH-290)
    ], /invoice|order|date|hsn|tel|dated|support|customer|phone|contact/i);

    // If no JH- style found, then look for SKU labels but still exclude phone numbers
    if (!sku) {
        sku = findLabelVal([/\bsku\b/i, /item\s*code/i], /[A-Z0-9][A-Z0-9\-\/]{1,25}/i);
        if (sku && /^\d{4,}/.test(sku)) sku = null; // Ignore if it's just a long phone-number-like sequence
    }

    // ═ TOTAL AMOUNT ═
    let amounts = [];
    // Allow amounts without decimals (e.g. 2800) but ensure they look like prices (at least 2 digits unless clearly a total)
    const floatRx = /\b(\d[\d,]*)(?:\.\d{1,2})?\b/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Lower case for matching
        const lowLine = line.toLowerCase();

        if (/(discount|save|saved|shipping|cgst|sgst|igst|tax|rate|qty|quantity|code|hsn|phone|tel)/i.test(line) && !/total/i.test(line)) continue;
        
        // Extra check for Amazon: if line contains "Total Tax" or "Total Shipping", skip it unless it's the only total
        if (isAmazon && /total\s*(tax|shipping|discount|savings|qty)/i.test(line)) continue;

        let m;
        let lineVals = [];
        while ((m = floatRx.exec(line)) !== null) {
            let s = m[1].replace(/,/g, '');
            if (m[0].includes('.')) s = m[0].replace(/,/g, ''); // Use full match if decimal exists
            const v = parseFloat(s);
            // Ignore small numbers that might be Qty or HSN parts unless the line has "Total"
            if (v > 10 || lowLine.includes('total')) lineVals.push(v);
        }

        if (lineVals.length > 0) {
            amounts.push({ val: lineVals[lineVals.length - 1], line, index: i });
        }
    }

    let finalAmount = null;
    // Strategy 1: Explicit Grand Total / Invoice Value
    const strongRx = /\b(?:grand\s*total|invoice\s*total|total\s*invoice\s*value|invoice\s*value|total\s*payable|amount\s*payable|total\s*amount|total\s*(?:\(rs\.\)|rs))\b/i;

    const strictLabel = amounts.slice().reverse().find(a =>
        strongRx.test(a.line) ||
        (a.index > 0 && strongRx.test(lines[a.index - 1]))
    );
    if (strictLabel) finalAmount = strictLabel.val;

    // Strategy 2: "TOTAL" line (check current or previous line, search bottom to top)
    if (!finalAmount) {
        const totalLabel = amounts.slice().reverse().find(a => {
            const isTotal = /\btotal\b/i.test(a.line) || (a.index > 0 && /\btotal\b/i.test(lines[a.index - 1]));
            const isNotSub = !/sub[ -]?total/i.test(a.line) && !(a.index > 0 && /sub[ -]?total/i.test(lines[a.index - 1]));
            return isTotal && isNotSub;
        });
        if (totalLabel) finalAmount = totalLabel.val;
    }

    // Strategy 3: The HIGHEST valid float on the entire document (fallback)
    if (!finalAmount && amounts.length > 0) {
        const max = Math.max(...amounts.map(a => a.val));
        if (max > 0 && max < 10000000) finalAmount = max;
    }

    const amtStr = finalAmount ? '₹' + finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

    // ═ TRACKING / AWB / PACKET ID — Collect ALL ═
    const tLabels = [
        /awb[\s]*(?:no|number|num|#)?/i, /tracking[\s]*(?:no|number|id|num|#)?/i,
        /packet[\s]*(?:id|no|number|num)?/i, /waybill[\s]*(?:no|number)?/i,
        /consignment[\s]*(?:no|number)?/i, /shipment[\s]*(?:id|no|number)?/i, /lbn[\s]*(?:no|number)?/i,
    ];
    const tParts = [], tSeen = new Set();
    for (let i = 0; i < lines.length; i++) {
        for (const rx of tLabels) {
            rx.lastIndex = 0;
            if (rx.test(lines[i])) {
                const vp = new RegExp(rx.source + '[\\s:.#=-]*([A-Za-z0-9][\\w\\-]{3,34})', 'i');
                const m = vp.exec(lines[i]);
                if (m && m[1] && m[1].length >= 4 && !tSeen.has(m[1]) && !m[1].match(/^\d{2}\.\d{2}\.\d{4}$/)) {
                    tSeen.add(m[1]); tParts.push(m[1]);
                }
                else if (i + 1 < lines.length) {
                    const n = lines[i + 1].trim();
                    if (/^[A-Za-z0-9][\w\-]{3,34}$/i.test(n) && !tSeen.has(n) && !n.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
                        tSeen.add(n); tParts.push(n);
                    }
                }
            }
        }
    }
    const trackingNo = tParts.length > 0 ? tParts.join(' | ') : null;
    return { order_no: orderNo || null, sku: sku || null, total_amount: amtStr || null, tracking_no: trackingNo || null };
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
$('clearQueueBtn').addEventListener('click', clearQueue);
$('scanBtn').addEventListener('click', startScan);

function addFiles(files) {
    files.forEach(f => {
        if (!fileQueue.find(q => q.file.name === f.name && q.status === 'pending'))
            fileQueue.push({ id: Date.now() + Math.random(), file: f, status: 'pending' });
    });
    renderQueue(); updateScanBtn();
}
function removeFromQueue(id) { fileQueue = fileQueue.filter(q => q.id !== id); renderQueue(); updateScanBtn(); }
function clearQueue() { fileQueue = fileQueue.filter(q => q.status === 'processing'); renderQueue(); updateScanBtn(); }
function updateScanBtn() { $('scanBtn').disabled = fileQueue.filter(q => q.status === 'pending').length === 0 || isScanning; }
function renderQueue() {
    const wrap = $('queueWrap');
    if (!fileQueue.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    $('queueCount').textContent = fileQueue.length;
    $('queueList').innerHTML = fileQueue.map(q => {
        const icon = { pending: '⏳', processing: '🔄', done: '✅', error: '❌' }[q.status];
        const cls = q.status === 'processing' ? 'q-item processing' : q.status === 'done' ? 'q-item done' : q.status === 'error' ? 'q-item error' : 'q-item';
        const rm = q.status !== 'processing' ? `<button class="q-remove" data-id="${q.id}">✕</button>` : '';
        return `<div class="${cls}"><span class="q-status">${icon}</span><span class="q-name" title="${q.file.name}">${q.file.name}</span><span class="q-size">${fmtSize(q.file.size)}</span>${rm}</div>`;
    }).join('');
    document.querySelectorAll('.q-remove').forEach(btn => { btn.onclick = () => removeFromQueue(parseFloat(btn.dataset.id)); });
}
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

// ── Scan (Local PDF.js) ──
async function startScan() {
    const pending = fileQueue.filter(q => q.status === 'pending');
    if (!pending.length || isScanning) return;
    isScanning = true; currentResults = [];
    $('scanBtn').disabled = true;
    $('scanBtnText').textContent = 'Scanning...';
    $('scanProgress').classList.add('show');
    $('errorAlert').classList.remove('show');
    const total = pending.length; let done = 0;
    for (const item of pending) {
        item.status = 'processing'; renderQueue();
        $('progLabel').textContent = `Scanning: ${item.file.name}`;
        $('progFrac').textContent = `${done + 1} / ${total}`;
        $('progBar').style.width = ((done / total) * 100) + '%';
        try {
            const text = await extractTextFromPDF(item.file);
            const data = extractOrderData(text);
            item.status = 'done';
            currentResults.push({ ...data, _file: item.file.name });
            addToHistory(data, item.file.name);
        } catch (e) {
            item.status = 'error'; console.error(item.file.name, e);
            $('errorAlert').classList.add('show');
            $('errorText').textContent = `Error: ${e.message}`;
        }
        done++; renderQueue();
        $('progBar').style.width = ((done / total) * 100) + '%';
        $('progFrac').textContent = `${done} / ${total}`;
    }
    isScanning = false;
    $('scanProgress').classList.remove('show');
    $('scanBtnText').textContent = 'Scan All PDFs';
    updateScanBtn(); renderResults();
    if (currentResults.length > 0) {
        $('resultsBadge').classList.remove('hidden');
        $('resultsBadge').textContent = currentResults.length;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="results"]').classList.add('active');
        $('tab-results').classList.add('active');
    }
    showToast('✅', `${done} PDF${done > 1 ? 's' : ''} scanned!`);
}

// ── Results Table ──
function renderResults() {
    $('resCount').textContent = currentResults.length + (currentResults.length === 1 ? ' entry' : ' entries');
    if (!currentResults.length) {
        $('resEmpty').style.display = 'block'; $('resTable').style.display = 'none'; return;
    }
    $('resEmpty').style.display = 'none'; $('resTable').style.display = 'table';
    $('resBody').innerHTML = currentResults.map((e, i) => `<tr>
    <td style="color:var(--t3)">${i + 1}</td>
    <td class="td-file" title="${e._file}">${e._file}</td>
    <td class="${e.order_no ? 'td-order' : 'td-nil'}">${e.order_no || '—'}</td>
    <td class="${e.sku ? 'td-sku' : 'td-nil'}">${e.sku || '—'}</td>
    <td class="${e.total_amount ? 'td-amount' : 'td-nil'}">${e.total_amount || '—'}</td>
    <td class="${e.tracking_no ? 'td-tracking' : 'td-nil'}">${e.tracking_no || '—'}</td>
  </tr>`).join('');
}

$('exportResBtn').addEventListener('click', () => {
    if (!currentResults.length) { showToast('⚠', 'No results to export.'); return; }
    const rows = [['#', 'File', 'Order No', 'SKU', 'Total Amount', 'Tracking / AWB']];
    currentResults.forEach((e, i) => rows.push([i + 1, e._file, e.order_no || '', e.sku || '', e.total_amount || '', e.tracking_no || '']));
    downloadExcel(rows, `ScanIQ_Results_${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ── Firebase History ──
function listenHistory() {
    if (histUnsub) histUnsub();
    const histRef = ref(db, 'users/' + uid + '/history');
    histUnsub = onValue(histRef, snap => {
        const val = snap.val();
        scanHistory = val ? Object.entries(val).map(([k, v]) => ({ _key: k, ...v })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) : [];
        renderHistory();
    });
}

function addToHistory(data, filename) {
    const now = new Date();
    set(push(ref(db, 'users/' + uid + '/history')), {
        file: filename, order_no: data.order_no || null, sku: data.sku || null,
        total_amount: data.total_amount || null, tracking_no: data.tracking_no || null,
        scanned_at: now.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        date_iso: now.toISOString().slice(0, 10), timestamp: serverTimestamp()
    });
}

function renderHistory() {
    $('histCount').textContent = scanHistory.length + (scanHistory.length === 1 ? ' entry' : ' entries');
    if (!scanHistory.length) { $('histEmpty').style.display = 'block'; $('histTable').style.display = 'none'; return; }
    $('histEmpty').style.display = 'none'; $('histTable').style.display = 'table';
    $('histBody').innerHTML = scanHistory.map((e, i) => {
        const found = [e.order_no, e.sku, e.total_amount, e.tracking_no].filter(Boolean).length;
        const badge = found === 4 ? `<span class="td-badge ok">✓ Complete</span>` : `<span class="td-badge partial">⚡ ${found}/4</span>`;
        return `<tr>
      <td style="color:var(--t3)">${i + 1}</td>
      <td class="td-file" title="${e.file}">${e.file}</td>
      <td class="${e.order_no ? 'td-order' : 'td-nil'}">${e.order_no || '—'}</td>
      <td class="${e.sku ? 'td-sku' : 'td-nil'}">${e.sku || '—'}</td>
      <td class="${e.total_amount ? 'td-amount' : 'td-nil'}">${e.total_amount || '—'}</td>
      <td class="${e.tracking_no ? 'td-tracking' : 'td-nil'}">${e.tracking_no || '—'}</td>
      <td>${badge}</td>
      <td class="td-time">${e.scanned_at || ''}</td>
    </tr>`;
    }).join('');
}

$('clearHistBtn').addEventListener('click', () => {
    if (!scanHistory.length) return;
    if (confirm('Clear all history?')) { remove(ref(db, 'users/' + uid + '/history')); showToast('🗑', 'History cleared.'); }
});

// ── Export Modal ──
$('exportBtn').addEventListener('click', openExportModal);
$('modalCloseBtn').addEventListener('click', closeExportModal);
$('modalCancelBtn').addEventListener('click', closeExportModal);
$('modalExportBtn').addEventListener('click', doExport);
$('exportFrom').addEventListener('input', updatePreview);
$('exportTo').addEventListener('input', updatePreview);
$('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) closeExportModal(); });

function openExportModal() {
    if (!scanHistory.length) { showToast('⚠', 'No data to export.'); return; }
    const today = new Date(), from30 = new Date(); from30.setDate(today.getDate() - 30);
    $('exportTo').value = today.toISOString().slice(0, 10);
    $('exportFrom').value = from30.toISOString().slice(0, 10);
    updatePreview();
    $('exportModal').classList.add('open');
}

function closeExportModal() { $('exportModal').classList.remove('open'); }

function filterHistoryByDate(from, to) {
    return scanHistory.filter(e => { const d = e.date_iso || ''; return !(from && d < from) && !(to && d > to); });
}

function updatePreview() {
    const from = $('exportFrom').value, to = $('exportTo').value;
    const f = filterHistoryByDate(from, to);
    $('previewText').textContent = f.length ? `${f.length} record${f.length !== 1 ? 's' : ''} found` : '⚠ No records in range';
}

function doExport() {
    const from = $('exportFrom').value, to = $('exportTo').value;
    const filtered = filterHistoryByDate(from, to);
    if (!filtered.length) { showToast('⚠', 'No records in range.'); return; }
    const rows = [['#', 'File', 'Order No', 'SKU', 'Total Amount', 'Tracking / AWB', 'Date']];
    filtered.forEach((e, i) => rows.push([i + 1, e.file, e.order_no || '', e.sku || '', e.total_amount || '', e.tracking_no || '', e.scanned_at || '']));
    downloadExcel(rows, from && to ? `ScanIQ_${from}_to_${to}.xlsx` : `ScanIQ_Export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    closeExportModal();
    showToast('✅', `${filtered.length} records exported!`);
}

function downloadExcel(rows, filename) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 24 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ScanIQ');
    XLSX.writeFile(wb, filename);
}

// ── Toast ──
function showToast(icon, msg) {
    $('toastIcon').textContent = icon;
    $('toastMsg').textContent = msg;
    const t = $('toast'); t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}
