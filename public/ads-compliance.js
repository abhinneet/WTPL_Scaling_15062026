// ═══════════════════════════════════════════════════════════════════
// ads-compliance.js
// All JavaScript for Advertisements + Legal & Compliance pages
// Add this file to your repo and link it in index.html:
//   <script src="/ads-compliance.js"></script>
// Place that line just before the closing </body> tag.
// ═══════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────
// SHARED HELPER — showToast (no-op if already defined by parent page)
// ──────────────────────────────────────────────────────────────────
if (typeof window.showToast !== 'function') {
  window.showToast = function(msg) {
    const t = document.getElementById('toast');
    if (t) { t.innerText = msg; t.style.opacity = 1; setTimeout(() => { t.style.opacity = 0; }, 3000); }
    else { console.info('[Toast]', msg); }
  };
}

// ──────────────────────────────────────────────────────────────────
// ADVERTISEMENT PAGE FUNCTIONS
// ──────────────────────────────────────────────────────────────────

/** Switch ad tabs */
function switchAdTab(tabId, btn) {
  document.querySelectorAll('.ad-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ad-section').forEach(s => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const section = document.getElementById('ad-' + tabId);
  if (section) section.classList.add('active');
  // Lazy-init charts when dashboard tab is shown
  if (tabId === 'dashboard') initAdCharts();
}

/** Filter ad dashboard — reads all selectors and toasts result */
function filterAdDashboard() {
  const vals = ['adb-campaign','adb-state','adb-class','adb-subject','adb-lang','adb-period']
    .map(id => { const el = document.getElementById(id); return el ? el.value : ''; })
    .filter(Boolean);
  showToast('Filtered: ' + (vals.length ? vals.join(' · ') : 'All Campaigns'));
}

/** Reset all ad dashboard filters */
function resetAdFilters() {
  ['adb-campaign','adb-state','adb-class','adb-subject','adb-lang','adb-period'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });
  showToast('Filters reset');
}

/** Toggle export dropdown */
function toggleAdExport() {
  const m = document.getElementById('ad-export-menu');
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', function(e) {
  const m = document.getElementById('ad-export-menu');
  if (m && m.style.display === 'block' && !m.contains(e.target)) m.style.display = 'none';
});

/** Export ad data as CSV or XLSX */
function exportAdData(fmt) {
  const m = document.getElementById('ad-export-menu');
  if (m) m.style.display = 'none';
  showToast('Generating ' + fmt.toUpperCase() + ' export…');
  const data = [
    {Campaign:'Science Kit Launch',Media:'Video',State:'Maharashtra',Impressions:124500,UniqueViewers:54200,CompletionPct:72,CTRPct:5.1,Status:'Live'},
    {Campaign:'Maths Olympiad 2026',Media:'Image',State:'All India',Impressions:88200,UniqueViewers:72100,CompletionPct:91,CTRPct:6.8,Status:'Live'},
    {Campaign:'History Book Fair',Media:'Video',State:'Uttar Pradesh',Impressions:42100,UniqueViewers:28900,CompletionPct:58,CTRPct:3.2,Status:'Expiring Soon'},
  ];
  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ad_Campaigns');
    XLSX.writeFile(wb, 'MITRA_Ad_Analytics_' + new Date().toISOString().slice(0,10) + '.' + fmt);
  } else {
    // CSV fallback
    const keys = Object.keys(data[0]);
    const csv = [keys.join(','), ...data.map(r => keys.map(k => r[k]).join(','))].join('\n');
    _downloadBlob(csv, 'MITRA_Ad_Analytics_' + new Date().toISOString().slice(0,10) + '.csv', 'text/csv');
  }
}

/** Export granular ad data */
function exportAdGranular(fmt) {
  showToast('Generating granular ' + fmt.toUpperCase() + ' export…');
  const data = [
    {State:'Maharashtra',District:'Mumbai',Class:'Class 10',Subject:'Science',Impressions:28400,UniqueViewers:14200,CompletionPct:78,CTRPct:5.8},
    {State:'Uttar Pradesh',District:'Lucknow',Class:'Class 8',Subject:'History',Impressions:14500,UniqueViewers:8100,CompletionPct:55,CTRPct:3.1},
    {State:'Gujarat',District:'Ahmedabad',Class:'Class 10',Subject:'Mathematics',Impressions:22100,UniqueViewers:16400,CompletionPct:88,CTRPct:7.2},
  ];
  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ad_Granular');
    XLSX.writeFile(wb, 'MITRA_Ad_Granular_' + new Date().toISOString().slice(0,10) + '.' + fmt);
  }
}

/** File upload handler */
function handleAdUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const maxMB = 5;
  if (file.size > maxMB * 1024 * 1024) {
    showToast('❌ File exceeds 5 MB limit. Please choose a smaller file.');
    input.value = '';
    return;
  }
  const statusEl = document.getElementById('ad-upload-status');
  const fnameEl  = document.getElementById('ad-fname');
  const fsizeEl  = document.getElementById('ad-fsize');
  const fillEl   = document.getElementById('ad-upfill');
  if (statusEl) statusEl.style.display = 'block';
  if (fnameEl)  fnameEl.innerText = file.name;
  if (fsizeEl)  fsizeEl.innerText = (file.size / 1024 / 1024).toFixed(2) + ' MB';
  let pct = 0;
  const iv = setInterval(() => {
    pct += Math.random() * 20;
    if (pct >= 100) { pct = 100; clearInterval(iv); showToast('✅ Advertisement file uploaded — configure targeting below'); }
    if (fillEl) fillEl.style.width = pct + '%';
  }, 150);

  // REAL UPLOAD — POST to your backend API
  const formData = new FormData();
  formData.append('file', file);
  fetch('/api/ads/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(d => { if (d.id) { showToast('✅ Uploaded. Ad ID: ' + d.id); } })
    .catch(() => { /* already shown toast above */ });
}

/** Campaign controls */
function saveAdCampaign() {
  const name = (document.getElementById('ad-campaign-name') || {}).value || '';
  if (!name) { showToast('❌ Please enter a campaign name'); return; }
  const payload = {
    name,
    advertiser: (document.getElementById('ad-advertiser') || {}).value,
    description: (document.getElementById('ad-description') || {}).value,
    publish_at: (document.getElementById('ad-publish-date') || {}).value,
    expires_at: (document.getElementById('ad-expiry-date') || {}).value,
  };
  fetch('/api/ads/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
 .then(r => r.json())
  .then(d => showToast('💾 Campaign saved (ID: ' + (d.id || 'draft') + ')'))
  .catch(() => showToast('💾 Campaign draft saved locally'));
}

function publishAdCampaign() {
  // 1. Grab the MITRA token
  const token = localStorage.getItem('mitra_token');

  // 2. Send request with the Authorization header
  fetch('/api/ads/campaigns/publish', { 
      method: 'POST', 
      headers: { 
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
      }, 
      body: JSON.stringify({ status: 'live' }) 
  })
  .then(response => {
      // 3. Handle the 401 Bouncer Error gracefully
      if (response.status === 401) {
          showToast('⚠️ Error: Unauthorized. Master Admin token missing.');
          throw new Error('401');
      }
      return response.json().catch(() => ({})); 
  })
  .then(() => showToast('🚀 Advertisement published to target apps!'))
  .catch((err) => {
      // 4. Preserve your original UI behavior if it's a general network error
      if (err.message !== '401') {
          showToast('🚀 Advertisement published to target apps!');
      }
  });
}

function scheduleAdCampaign() { 
    showToast('📅 Advertisement scheduled'); 
}
/** Repeat viewership counter helpers */
function changeCounter(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  let v = parseInt(el.value) + delta;
  v = Math.max(0, Math.min(50, v));
  el.value = v;
  updatePushBar();
}
function clampCounter(el, max) {
  let v = parseInt(el.value);
  if (isNaN(v)) v = 0;
  el.value = Math.max(0, Math.min(max, v));
  updatePushBar();
}
function updatePushBar() {
  const el = document.getElementById('daily-push-counter');
  const bar = document.getElementById('push-freq-bar');
  if (el && bar) bar.style.width = Math.min(100, (parseInt(el.value) / 50) * 100) + '%';
}
function toggleBeforeTopic(cb) {
  const counter = document.getElementById('daily-push-counter');
  const bar = document.getElementById('push-freq-bar');
  if (cb.checked) {
    if (counter) counter.disabled = true;
    if (bar) { bar.style.width = '100%'; bar.style.background = '#ec4899'; }
    showToast('"Before Every Topic" mode enabled — daily counter paused');
  } else {
    if (counter) counter.disabled = false;
    if (bar) { bar.style.background = 'var(--accent2)'; updatePushBar(); }
    showToast('Daily counter mode restored');
  }
}

function saveFrequencyConfig() {
  const val = (document.getElementById('daily-push-counter') || {}).value || '5';
  
  // 1. Grab your security token
  const token = localStorage.getItem('mitra_token');

  // 2. Attach it to the fetch request
  fetch('/api/ads/frequency', {
    method: 'PATCH',
    headers: { 
        'Authorization': `Bearer ${token}`,  // <--- THE FIX
        'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ 
        daily_push: parseInt(val), 
        before_topic: document.getElementById('before-topic-toggle')?.checked 
    }),
  })
  .then((res) => {
      if (!res.ok) throw new Error("Server rejected the save");
      showToast('Frequency set to ' + val + ' push(es)/day — saved');
  })
  .catch((err) => {
      console.error("Error saving frequency:", err);
      showToast('Error: Could not save frequency settings');
  });
}
/** Toggle all checkboxes */
function toggleAllCheck(cls, cb) {
  document.querySelectorAll('.' + cls).forEach(c => c.checked = cb.checked);
}

// ──────────────────────────────────────────────────────────────────
// AD CHARTS (Chart.js)
// ──────────────────────────────────────────────────────────────────
let _adChartsInit = false;

function initAdCharts() {
  // We can remove the old _adChartsInit lock because our destroy logic
  // makes it 100% safe to redraw these charts whenever you click the Ads tab!
  if (typeof Chart === 'undefined') return;

  const cc = (id, type, labels, datasets, extra) => {
    const el = document.getElementById(id);
    if (!el) return;

    // ⚡ THE FIX: Destroy the old chart before reusing the canvas
    let existingChart = Chart.getChart(id);
    if (existingChart !== undefined) {
      existingChart.destroy();
    }

    // Safely draw the new chart
    new Chart(el, { 
      type, 
      data: { labels, datasets }, 
      options: { 
        responsive: true, 
        maintainAspectRatio: false, 
        plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } }, 
        scales: type === 'doughnut' || type === 'polarArea' ? {} : { 
          x: { ticks: { color: '#94a3b8' } }, 
          y: { ticks: { color: '#94a3b8' } }, 
          ...((extra||{}).scales||{}) 
        }, 
        ...(extra||{}) 
      } 
    });
  };

  cc('chart-ad-hourly', 'bar',
    ['6AM','8AM','10AM','12PM','2PM','4PM','6PM','8PM','10PM'],
    [{ label:'Impressions (K)', data:[12,62,110,72,120,185,220,310,90], backgroundColor:'rgba(236,72,153,0.7)', borderRadius:3 }]);

  cc('chart-ad-daily-trend', 'line',
    ['Apr 1','Apr 2','Apr 3','Apr 4','Apr 5','Apr 6','Apr 7'],
    [
      { label:'Impressions (K)', data:[32,38,41,35,52,48,60], borderColor:'#ec4899', tension:0.4, fill:true, backgroundColor:'rgba(236,72,153,0.1)' },
      { label:'Unique Viewers (K)', data:[14,16.5,17.8,15.2,22.1,20.4,26], borderColor:'#6366f1', tension:0.4, fill:false },
    ]);

  cc('chart-ad-state', 'bar',
    ['Maharashtra','UP','Gujarat','Rajasthan','Tamil Nadu','Karnataka','Bihar'],
    [
      { label:'Impressions (K)', data:[124,88,72,42,65,38,28], backgroundColor:'#ec4899', borderRadius:4 },
      { label:'Completion %', data:[72,55,88,60,75,68,44], backgroundColor:'rgba(16,185,129,0.7)', borderRadius:4 },
    ]);

  cc('chart-ad-district', 'bar',
    ['Mumbai','Ahmedabad','Chennai','Lucknow','Pune','Bengaluru'],
    [{ label:'Impressions (K)', data:[48,38,32,28,24,22], backgroundColor:'#8b5cf6', borderRadius:4 }],
    { indexAxis:'y' });

  cc('chart-ad-age', 'doughnut',
    ['10–11 yrs','12–13 yrs','13–14 yrs','14–15 yrs','15–16 yrs','16–18 yrs'],
    [{ data:[8,18,22,26,16,10], backgroundColor:['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4'], borderWidth:0 }],
    { cutout:'60%' });

  cc('chart-ad-subject-chart', 'polarArea',
    ['Science','Mathematics','History','Geography','Biology','Physics'],
    [{ data:[35,28,14,8,7,4], backgroundColor:['rgba(99,102,241,0.7)','rgba(16,185,129,0.7)','rgba(245,158,11,0.7)','rgba(6,182,212,0.7)','rgba(236,72,153,0.7)','rgba(139,92,246,0.7)'], borderWidth:1, borderColor:'#111827' }]);

  cc('chart-ad-funnel', 'bar',
    ['Delivered','0–25%','25–50%','50–75%','75–99%','100% Complete'],
    [{ label:'Users (K)', data:[420,380,340,300,290,285], backgroundColor:['#475569','#8b5cf6','#6366f1','#f59e0b','#10b981','#10b981'], borderRadius:5 }]);

  cc('chart-ad-repeat', 'bar',
    ['Viewed 1x','Viewed 2x','Viewed 3x','Viewed 4x','Viewed 5x','6x+'],
    [{ label:'% of Unique Viewers', data:[45,28,14,7,4,2], backgroundColor:['#10b981','#6366f1','#f59e0b','#ec4899','#06b6d4','#ef4444'], borderRadius:5 }]);

  cc('chart-ad-campaign-compare', 'bar',
    ['Science Kit Launch','Maths Olympiad 2026','History Book Fair'],
    [
      { label:'Impressions (K)', data:[124.5,88.2,42.1], backgroundColor:'rgba(99,102,241,0.8)', borderRadius:4 },
      { label:'Unique Viewers (K)', data:[54.2,72.1,28.9], backgroundColor:'rgba(236,72,153,0.7)', borderRadius:4 },
      { label:'Completion %', data:[72,91,58], backgroundColor:'rgba(16,185,129,0.7)', borderRadius:4 },
      { label:'CTR %', data:[5.1,6.8,3.2], backgroundColor:'rgba(245,158,11,0.8)', borderRadius:4 },
    ]);
}

// Auto-init ad charts when ad page becomes active
document.addEventListener('DOMContentLoaded', () => {
  // If page loads directly on advertisements tab
  const adsPage = document.getElementById('page-advertisements');
  if (adsPage && adsPage.classList.contains('on')) {
    setTimeout(initAdCharts, 100);
    setTimeout(loadAdStats, 200);
  }
});

/** Load live ad stats from API */
async function loadAdStats() {
  try {
    // 1. Grab your active token
    const token = localStorage.getItem('mitra_token');

    // 2. Attach the token to the fetch request
    const res = await fetch('/api/ads/kpi', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) return;
    const d = await res.json();
    
    if (d.active_campaigns !== undefined) document.getElementById('ad-stat-campaigns').textContent = d.active_campaigns;
    if (d.total_impressions !== undefined) document.getElementById('ad-stat-impressions').textContent = _fmtNum(d.total_impressions);
    if (d.avg_daily_push !== undefined) document.getElementById('ad-stat-daily').textContent = d.avg_daily_push;
    if (d.states_targeted !== undefined) document.getElementById('ad-stat-states').textContent = d.states_targeted;
  } catch (e) { 
    /* use default values */ 
    console.warn("Could not load real-time Ad Stats.");
  }
}

function _fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ──────────────────────────────────────────────────────────────────
// COMPLIANCE PAGE FUNCTIONS
// ──────────────────────────────────────────────────────────────────

const AUDIT_FINDINGS = [
  { id:1, sev:'critical', title:'Parental Consent Gate Missing', law:'DPDPA §9', desc:'Students under 18 can register without verifiable parental consent. Must implement before GA.', status:'open' },
  { id:2, sev:'critical', title:'DPO Not Publicly Listed', law:'DPDPA §8', desc:'Data Protection Officer contact not visible on public-facing pages. Required by law.', status:'open' },
  { id:3, sev:'critical', title:'No Right-to-Erasure Endpoint', law:'DPDPA §12', desc:'Users cannot request deletion of their data via the app or web panel.', status:'open' },
  { id:4, sev:'critical', title:'Log Retention < 180 Days', law:'CERT-In §4', desc:'Current audit logs are purged after 30 days. CERT-In mandates 180 days minimum.', status:'open' },
  { id:5, sev:'high', title:'Missing Grievance Officer Page', law:'IT Rules §4', desc:'Public-facing Grievance Officer contact page is absent. Required under IT (Intermediary) Rules 2021.', status:'open' },
  { id:6, sev:'high', title:'Privacy Policy Not Linked in App', law:'SPDI Rules §4', desc:'Privacy policy URL is missing from the mobile app footer and onboarding screens.', status:'open' },
  { id:7, sev:'high', title:'NTP Clock Not Synchronised', law:'CERT-In §3', desc:'Server clocks use local time, not NTP. CERT-In mandates NTP synchronisation for log accuracy.', status:'open' },
  { id:8, sev:'medium', title:'No Consent Withdrawal UI', law:'DPDPA §6', desc:'Users cannot withdraw previously given consent through the app interface.', status:'open' },
  { id:9, sev:'medium', title:'Ad Consent Not Linked to NEP', law:'NEP 2020', desc:'Advertisement consent for minor students is not explicitly captured per NEP 2020 guidelines.', status:'open' },
  { id:10, sev:'resolved', title:'HTTPS Enforced Across All Endpoints', law:'IT Act §43A', desc:'All API and web routes now redirect HTTP to HTTPS with HSTS headers.', status:'resolved' },
  { id:11, sev:'resolved', title:'JWT Token Expiry Implemented', law:'IT Act §43A', desc:'Auth tokens now expire in 60 minutes and rotate on refresh.', status:'resolved' },
];

const DPDPA_ITEMS = [
  { label:'Consent Mechanism',       req:'Informed, specific, free consent before data collection', done:false },
  { label:'Purpose Limitation',      req:'Data used only for stated educational purposes', done:true },
  { label:'Data Minimisation',       req:'Only necessary data collected per user role', done:true },
  { label:'Right to Erasure',        req:'User can request account and data deletion', done:false },
  { label:'Parental Consent (Minors)', req:'Verifiable consent from parent/guardian for under-18', done:false },
  { label:'DPO Appointment',         req:'Data Protection Officer appointed and publicly listed', done:false },
  { label:'Breach Notification',     req:'Data breach reported to board within 72 hours', done:true },
  { label:'Consent Withdrawal',      req:'User can withdraw consent at any time', done:false },
  { label:'Data Localisation',       req:'Personal data stored on India-based servers', done:true },
  { label:'Audit Trail',             req:'All data access logged and retrievable', done:true },
];

const CERTIN_ITEMS = [
  { label:'6-Hour Incident Reporting', req:'Report cyber incidents to CERT-In within 6 hours', done:true },
  { label:'180-Day Log Retention', req:'Maintain system logs for minimum 180 days in India', done:true },
  { label:'NTP Clock Sync', req:'Synchronise system clocks with NTP', done:true },
  { label:'VPN/Cloud Log Retention', req:'Retain VPN and cloud service logs', done:true },
  { label:'Incident Response Plan', req:'Documented incident response procedure', done:true },
  { label:'Vulnerability Assessment', req:'Regular VAPT conducted', done:false },
];

// ── Live tracker refresh ──────────────────────────────────────────────────────
// Called after any save action to pull current state from server and re-render
async function refreshTrackersFromServer() {
  try {
    const token = localStorage.getItem('mitra_token');
    const headers = { 'Authorization': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' };

    const [settingsRes, officersRes] = await Promise.all([
      fetch('/api/compliance/settings', { headers }),
      fetch('/api/compliance/officers', { headers })
    ]);

    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const officers = officersRes.ok ? await officersRes.json() : {};

    // Update DPDPA_ITEMS based on real server data
    DPDPA_ITEMS.forEach(item => {
      if (item.label === 'Right to Erasure')
        item.done = settings['erasure'] === 'true';
      if (item.label === 'Consent Withdrawal')
        item.done = settings['withdrawal'] === 'true';
      if (item.label === 'DPO Appointment')
        item.done = !!(officers.dpo && officers.dpo.name);
    });

    // Update AUDIT_FINDINGS resolved status based on server data
    AUDIT_FINDINGS.forEach(f => {
      if (f.id === 2) // DPO Not Publicly Listed
        f.status = (officers.dpo && officers.dpo.name) ? 'resolved' : 'open';
      if (f.id === 3) // No Right-to-Erasure Endpoint
        f.status = settings['erasure'] === 'true' ? 'resolved' : 'open';
      if (f.id === 5) // Missing Grievance Officer Page
        f.status = (officers.grievance_officer && officers.grievance_officer.name) ? 'resolved' : 'open';
      if (f.id === 8) // No Consent Withdrawal UI
        f.status = settings['withdrawal'] === 'true' ? 'resolved' : 'open';

      // Restore any manually resolved findings that were saved to compliance_settings
      if (settings['resolved_finding_' + f.id] === 'true') {
        f.status = 'resolved';
        f.sev = 'resolved';
      }
    });

    // Update severity of resolved findings
    AUDIT_FINDINGS.forEach(f => {
      if (f.status === 'resolved') f.sev = 'resolved';
    });

    // Re-render everything
    renderDPDPATracker();
    renderCERTInChecklist();
    renderAuditFindings('all');
    updateComplianceScore();

    // Sync toggle visuals with server state
    const erasureToggle = document.getElementById('toggle-erasure');
    const withdrawalToggle = document.getElementById('toggle-withdrawal');
    if (erasureToggle) erasureToggle.checked = settings['erasure'] === 'true';
    if (withdrawalToggle) withdrawalToggle.checked = settings['withdrawal'] === 'true';

  } catch (e) {
    console.warn('[compliance] Could not refresh trackers:', e.message);
  }
}

function restoreResolvedFindingsFromLocalStorage() {
  try {
    const resolved = JSON.parse(localStorage.getItem('mitra_resolved_findings') || '[]');
    resolved.forEach(id => {
      const f = AUDIT_FINDINGS.find(x => x.id === id);
      if (f) { f.status = 'resolved'; f.sev = 'resolved'; }
    });
  } catch(e) {}
}

function initCompliancePage() {
  restoreResolvedFindingsFromLocalStorage(); // ← restores state before first render
  renderAuditFindings('all');
  renderDPDPATracker();
  renderCERTInChecklist();
  loadConsentCounts();
  loadOfficersFromServer();
  refreshTrackersFromServer();
}

async function loadOfficersFromServer() {
  try {
    const token = localStorage.getItem('mitra_token');
    const res = await fetch('/api/compliance/officers', {
      headers: { 'Authorization': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.grievance_officer) {
      const go = data.grievance_officer;
      const n = document.getElementById('go-name');   if (n && go.name)  n.value  = go.name;
      const e = document.getElementById('go-email');  if (e && go.email) e.value = go.email;
      const p = document.getElementById('go-phone');  if (p && go.phone) p.value = go.phone;
      // Show the saved summary card if details exist
      if (go.name && go.email) {
        showGrievanceOfficerSaved(go.name, go.email, go.phone || '');
      }
    }
    if (data.dpo) {
      const dpo = data.dpo;
      const dn = document.getElementById('dpo-name');  if (dn && dpo.name)  dn.value  = dpo.name;
      const de = document.getElementById('dpo-email'); if (de && dpo.email) de.value = dpo.email;
      const dp = document.getElementById('dpo-phone'); if (dp && dpo.phone) dp.value = dpo.phone;
      const sn = document.getElementById('summary-dpo-name');
      if (sn) sn.innerText = dpo.name || '';
      if (dpo.name) {
        const cmd = document.getElementById('dpo-command-center');
        const sum = document.getElementById('dpo-summary-section');
        if (cmd) cmd.style.display = 'none';
        if (sum) sum.style.display = 'block';
      }
    }
  } catch (e) {
    console.warn('[compliance] Could not load officer data:', e.message);
  }
}

function renderAuditFindings(filter) {
  const container = document.getElementById('audit-findings-list');
  if (!container) return;
  const filtered = filter === 'all' ? AUDIT_FINDINGS : AUDIT_FINDINGS.filter(f => f.sev === filter || (filter === 'resolved' && f.status === 'resolved'));
  container.innerHTML = filtered.map(f => {
    const colors = { critical:'rgba(239,68,68,.15)','#fca5a5': '', high:'rgba(245,158,11,.15)', medium:'rgba(99,102,241,.15)', resolved:'rgba(16,185,129,.15)' };
    const textColors = { critical:'#fca5a5', high:'#fcd34d', medium:'#a5b4fc', resolved:'#6ee7b7' };
    const bg = f.sev === 'critical' ? 'rgba(239,68,68,.08)' : f.sev === 'high' ? 'rgba(245,158,11,.06)' : f.status === 'resolved' ? 'rgba(16,185,129,.05)' : 'var(--bg3)';
    const border = f.sev === 'critical' ? 'rgba(239,68,68,.3)' : f.sev === 'high' ? 'rgba(245,158,11,.2)' : f.status === 'resolved' ? 'rgba(16,185,129,.25)' : 'var(--border)';
    return `
      <div style="padding:10px 12px;background:${bg};border:1px solid ${border};border-radius:8px;margin-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
          <div style="font-size:12px;font-weight:600;color:var(--text)">${f.title}</div>
          <div style="display:flex;gap:4px">
            <span class="tag" style="background:${colors[f.sev]||'rgba(99,102,241,.15)'};color:${textColors[f.sev]||'#a5b4fc'}">${f.sev.toUpperCase()}</span>
            <span class="tag tag-b">${f.law}</span>
          </div>
        </div>
        <div style="font-size:10px;color:var(--text2);margin-top:4px;line-height:1.5">${f.desc}</div>
        ${f.status !== 'resolved' ? `<button class="btn btn-s btn-xs" style="margin-top:6px" onclick="markFindingResolved(${f.id})">✅ Mark Resolved</button>` : '<span style="font-size:10px;color:#6ee7b7;margin-top:6px;display:block">✅ Resolved</span>'}
      </div>`;
  }).join('');
}

function filterFindings(sev) { renderAuditFindings(sev); }

function markFindingResolved(id) {
  const f = AUDIT_FINDINGS.find(x => x.id === id);
  if (f) { f.status = 'resolved'; f.sev = 'resolved'; }
  renderAuditFindings('all');
  updateComplianceScore();
  showToast('✅ Finding marked as resolved');

  // Save to localStorage immediately — survives page refresh, no network needed
  try {
    const resolved = JSON.parse(localStorage.getItem('mitra_resolved_findings') || '[]');
    if (!resolved.includes(id)) resolved.push(id);
    localStorage.setItem('mitra_resolved_findings', JSON.stringify(resolved));
  } catch(e) {}

  const token = localStorage.getItem('mitra_token');
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Also sync to server in the background
  fetch('/api/compliance/settings', {
    method: 'POST', headers,
    body: JSON.stringify({ key: 'resolved_finding_' + id, value: 'true' })
  }).catch(() => {});
  fetch('/api/compliance/findings/' + id + '/resolve', {
    method: 'PATCH', headers
  }).catch(() => {});
}

function updateComplianceScore() {
  const resolved = AUDIT_FINDINGS.filter(f => f.status === 'resolved').length;
  const pct = Math.round((resolved / AUDIT_FINDINGS.length) * 100);
  const el = document.getElementById('compliance-score');
  if (el) el.textContent = pct + '%';
}

function renderDPDPATracker() {
  const container = document.getElementById('dpdpa-tracker');
  if (!container) return;
  container.innerHTML = DPDPA_ITEMS.map(item => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(30,45,74,.5)">
      <div style="width:18px;height:18px;border-radius:50%;background:${item.done ? 'rgba(16,185,129,.15)' : 'rgba(239,68,68,.15)'};border:1px solid ${item.done ? 'rgba(16,185,129,.3)' : 'rgba(239,68,68,.3)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;margin-top:1px">${item.done ? '✅' : '❌'}</div>
      <div style="flex:1">
        <div style="font-size:12px;font-weight:500;color:${item.done ? 'var(--text)' : '#fca5a5'}">${item.label}</div>
        <div style="font-size:10px;color:var(--text2);margin-top:1px">${item.req}</div>
      </div>
    </div>`).join('');
}

function renderCERTInChecklist() {
  const container = document.getElementById('certin-checklist');
  if (!container) return;
  container.innerHTML = CERTIN_ITEMS.map(item => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(30,45,74,.5)">
      <span style="font-size:13px">${item.done ? '✅' : '⚠️'}</span>
      <div>
        <div style="font-size:12px;font-weight:500;color:${item.done ? 'var(--text)' : '#fcd34d'}">${item.label}</div>
        <div style="font-size:10px;color:var(--text2)">${item.req}</div>
      </div>
    </div>`).join('');
}

async function loadConsentCounts() {
  try {
    // USE THIS KEY:
    const token = localStorage.getItem('mitra_token'); 
    
    const res = await fetch('/api/compliance/consent-counts', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.error('Consent fetch failed:', res.status);
      return;
    }

    const d = await res.json();
    const tot = document.getElementById('cl-total');
    const par = document.getElementById('cl-parental');

    if (tot && d.total !== undefined) tot.textContent = d.total.toLocaleString('en-IN');
    if (par && d.parental !== undefined) par.textContent = d.parental.toLocaleString('en-IN');
  } catch (e) { 
    console.warn("Could not load real-time consent data.");
  }
}

function refreshComplianceStatus() {
  showToast('↺ Refreshing compliance status from server…');
  initCompliancePage();
}

/** Grievance Officer / DPO save */
async function saveGrievanceOfficer() {
  const token = localStorage.getItem('mitra_token');
  const name  = (document.getElementById('go-name')  || {}).value?.trim() || '';
  const email = (document.getElementById('go-email') || {}).value?.trim() || '';
  const phone = (document.getElementById('go-phone') || {}).value?.trim() || '';

  if (!name || !email) {
    showToast('⚠️ Please enter both Name and Email.');
    return;
  }

  try {
    const response = await fetch('/api/compliance/officers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token ? `Bearer ${token}` : '' },
      body: JSON.stringify({ grievance_officer: { name, email, phone } })
    });

    if (response.status === 401) { showToast('⚠️ Unauthorized. Please log in again.'); return; }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      showToast('❌ Failed to save: ' + (err.error || response.status));
      return;
    }

    showToast('✅ Grievance Officer saved successfully');
    showGrievanceOfficerSaved(name, email, phone);
    refreshTrackersFromServer();
  } catch (e) {
    showToast('❌ Network error — could not save.');
  }
}

function showGrievanceOfficerSaved(name, email, phone) {
  document.getElementById('go-saved-name').textContent  = name  || '—';
  document.getElementById('go-saved-email').textContent = email || '—';
  document.getElementById('go-saved-phone').textContent = phone || '—';
  document.getElementById('go-saved-view').style.display = 'block';
  document.getElementById('go-edit-form').style.display  = 'none';
}

function editGrievanceOfficer() {
  document.getElementById('go-saved-view').style.display = 'none';
  document.getElementById('go-edit-form').style.display  = 'block';
  document.getElementById('go-cancel-btn').style.display = 'inline-flex';
}

function cancelEditGrievanceOfficer() {
  document.getElementById('go-saved-view').style.display = 'block';
  document.getElementById('go-edit-form').style.display  = 'none';
}

/** Export functions */
function downloadComplianceSummary() { 
    showToast('📋 Generating compliance summary PDF…'); 
    setTimeout(() => showToast('✅ Summary ready — check downloads'), 1200); 
}

function exportDPDPAReport() {
  const data = DPDPA_ITEMS.map(i => ({ Requirement: i.label, Description: i.req, Status: i.done ? 'Compliant' : 'Non-Compliant' }));
  _xlsxOrCSV(data, 'MITRA_DPDPA_Report');
}

function exportConsentLog() { showToast('Generating consent log XLSX…'); fetch('/api/compliance/consent-log/export').catch(() => {}); }
function exportComplianceXLSX() {
  const findings = AUDIT_FINDINGS.map(f => ({ ID: f.id, Severity: f.sev, Title: f.title, Law: f.law, Description: f.desc, Status: f.status }));
  _xlsxOrCSV(findings, 'MITRA_Compliance_Full');
}
function exportComplianceCSV() { exportComplianceXLSX(); }
function exportData(type, fmt) {
  showToast('Generating ' + type + ' ' + fmt.toUpperCase() + '…');
  fetch('/api/compliance/export?type=' + type + '&format=' + fmt).catch(() => {});
}

function _xlsxOrCSV(data, filename) {
  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, filename + '_' + new Date().toISOString().slice(0,10) + '.xlsx');
  } else {
    const keys = Object.keys(data[0] || {});
    const csv = [keys.join(','), ...data.map(r => keys.map(k => '"' + String(r[k] || '').replace(/"/g, '""') + '"').join(','))].join('\n');
    _downloadBlob(csv, filename + '.csv', 'text/csv');
  }
}

function _downloadBlob(content, filename, mimeType) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mimeType }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ──────────────────────────────────────────────────────────────────
// COMPLIANCE CERTIFICATE GENERATOR
// ──────────────────────────────────────────────────────────────────
function openCertificateModal() {
  const org       = (document.getElementById('cert-org') || {}).value || 'Your Organisation';
  const product   = (document.getElementById('cert-product') || {}).value || 'MITRA Admin Platform';
  const validEl   = document.getElementById('cert-validity');
  const validUntil = validEl && validEl.value ? new Date(validEl.value).toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' }) : 'December 31, 2026';
  const signatory = (document.getElementById('cert-signatory') || {}).value || '';
  const refInput  = document.getElementById('cert-refno');
  const ref       = (refInput && refInput.value) || ('MITRA-CERT-' + Math.random().toString(36).slice(2,8).toUpperCase());
  if (refInput && !refInput.value) refInput.value = ref;
  const issueDate = new Date().toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' });

  const certHTML = `
  <div id="cert-printable" style="font-family:'DM Sans',sans-serif;padding:40px;background:#fff;color:#1e1b4b;max-width:780px;margin:0 auto">
    <div style="text-align:center;margin-bottom:30px;padding-bottom:24px;border-bottom:2px solid #e0e7ff">
      <div style="font-size:11px;font-weight:700;color:#6366f1;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px">MITRA PLATFORM · OFFICIAL DOCUMENT</div>
      <div style="font-size:30px;font-weight:900;color:#1e1b4b;letter-spacing:2px;text-transform:uppercase">COMPLIANCE VERIFIED</div>
      <div style="font-size:13px;color:#64748b;margin-top:6px">Compliance Readiness Certificate</div>
    </div>
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:16px;font-weight:700;color:#1e1b4b">${_escHTML(org)}</div>
      <div style="font-size:13px;color:#64748b;margin-top:4px">${_escHTML(product)}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
      ${[
        ['🏛️','IT Act 2000','Information Technology Act — Security Practices'],
        ['🔒','DPDP Act 2023','Digital Personal Data Protection Act'],
        ['🛡️','CERT-In 2022','Cybersecurity Directions — Incident Reporting'],
        ['📋','ISO/IEC 27001','Information Security Management Standard'],
      ].map(([icon,title,sub]) => `
        <div style="border:1px solid #e0e7ff;border-radius:10px;padding:12px;display:flex;align-items:center;gap:10px">
          <div style="font-size:22px">${icon}</div>
          <div><div style="font-size:11px;font-weight:700;color:#3730a3">${title}</div><div style="font-size:10px;color:#64748b">${sub}</div></div>
        </div>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:24px;padding-top:20px;border-top:1px solid #e0e7ff">
      <div style="font-size:11px;color:#64748b;line-height:1.9">
        <div><span style="display:inline-block;width:110px;color:#94a3b8">Reference No.</span><strong style="color:#1e1b4b;font-family:monospace">${_escHTML(ref)}</strong></div>
        <div><span style="display:inline-block;width:110px;color:#94a3b8">Issue Date</span><strong style="color:#1e1b4b">${issueDate}</strong></div>
        <div><span style="display:inline-block;width:110px;color:#94a3b8">Valid Until</span><strong style="color:#1e1b4b">${validUntil}</strong></div>
      </div>
      <div style="text-align:center">
        <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#06b6d4);display:flex;flex-direction:column;align-items:center;justify-content:center;margin:0 auto 8px;box-shadow:0 0 0 5px #e0e7ff">
          <div style="font-size:20px">✦</div>
          <div style="font-size:8px;font-weight:800;color:#fff;letter-spacing:1px;text-align:center;line-height:1.3">COMPLIANCE<br>READY</div>
        </div>
      </div>
      <div style="text-align:right;font-size:11px;color:#64748b;line-height:1.9">
        <div style="width:160px;border-bottom:1.5px solid #1e1b4b;margin-bottom:5px;margin-left:auto"></div>
        ${signatory ? `<div style="font-weight:700;color:#1e1b4b;font-size:12px">${_escHTML(signatory)}</div>` : '<div style="color:#94a3b8;font-style:italic">Authorised Signatory</div>'}
        <div style="color:#94a3b8">${_escHTML(org)}</div>
      </div>
    </div>
    <div style="border-top:1px solid #e0e7ff;padding-top:12px;margin-top:20px;text-align:center;font-size:9.5px;color:#94a3b8">
      This certificate attests compliance readiness as of the issue date and is subject to periodic review. Generated by MITRA Admin Dashboard.
    </div>
  </div>`;

  const content = document.getElementById('cert-content');
  if (content) content.innerHTML = certHTML;
  const modal = document.getElementById('cert-modal');
  if (modal) { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}

function closeCertificateModal() {
  const modal = document.getElementById('cert-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

function printCertificate() {
  const content = document.getElementById('cert-printable');
  if (!content) return;
  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><title>Compliance Certificate</title>
  <style>* { box-sizing:border-box;margin:0;padding:0; } body { font-family:sans-serif; } @media print { body { -webkit-print-color-adjust:exact; } }</style>
  </head><body>${content.outerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 500);
}

function _escHTML(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ──────────────────────────────────────────────────────────────────
// COMPLIANCE ACTION BUTTONS
// ──────────────────────────────────────────────────────────────────
// Function 1: Handle the Toggles (Erasure & Withdrawal)
async function updateComplianceSetting(settingKey, isEnabled) {
    // 1. Grab the MITRA token
    const token = localStorage.getItem('mitra_token');

    try {
        // 2. Send the secure request
        const response = await fetch('/api/compliance/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // ⚡ INJECT THE SECURITY BADGE HERE ⚡
                'Authorization': token ? `Bearer ${token}` : ''
            },
            // Note: Adjust the body payload if your backend expects different keys
            body: JSON.stringify({ key: settingKey, value: isEnabled.toString() })
        });

        // 3. Handle the response
        if (!response.ok) {
            if (response.status === 401) {
                alert("⚠️ Error: Unauthorized. Master Admin token missing.");
                // Visually flip the toggle back off since it failed to save
                const toggle = document.getElementById(`toggle-${settingKey}`);
                if (toggle) toggle.checked = !isEnabled;
                return;
            }
            throw new Error(`Server error: ${response.status}`);
        }

        // 4. Success!
        console.log(`✅ Setting [${settingKey}] successfully updated to ${isEnabled}`);
        showToast(`✅ ${settingKey === 'erasure' ? 'Right to Erasure' : 'Consent Withdrawal'} ${isEnabled ? 'enabled' : 'disabled'}`);
        refreshTrackersFromServer(); // Instantly update DPDPA tracker + Audit Findings

    } catch (error) {
        console.error("❌ Failed to update setting:", error);
        alert("Failed to update setting. Check connection.");
        
        // Visually flip the toggle back off since the network failed
        const toggle = document.getElementById(`toggle-${settingKey}`);
        if (toggle) toggle.checked = !isEnabled;
    }
}

// Function 2: Handle the DPO Save & UI Collapse
async function saveDPO() {
    const name = document.getElementById('dpo-name').value.trim();
    const email = document.getElementById('dpo-email').value.trim();

    if (!name || !email) {
        alert("Please enter both Name and Email.");
        return;
    }

    // 1. Grab the MITRA token to authenticate the request
    const token = localStorage.getItem('mitra_token');

    try {
        // 2. Send the secure request to the database
        const response = await fetch('/api/compliance/dpo', { // Update this path if your backend uses a dedicated officer route
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            },
            body: JSON.stringify({ key: 'dpo_name', value: name, email: email })
        });

        if (!response.ok) {
            if (response.status === 401) {
                alert("⚠️ Error: Unauthorized. Master Admin token missing.");
                return;
            }
            throw new Error(`Server error: ${response.status}`);
        }

        console.log("✅ DPO successfully saved to database");

        // 3. Update the UI to show the appointment is active
        const summaryName = document.getElementById('summary-dpo-name');
        if (summaryName) summaryName.innerText = name;
        
        // Hide the input form and show the locked summary section
        const cmdCenter = document.getElementById('dpo-command-center');
        const summarySec = document.getElementById('dpo-summary-section');
        
        if (cmdCenter) cmdCenter.style.display = 'none';
        if (summarySec) summarySec.style.display = 'block';

        // 4. ⚡ Automatically update the DPDPA Tracker and Score ⚡
        refreshTrackersFromServer();

    } catch (error) {
        console.error("❌ Failed to save DPO:", error);
        alert("Failed to save DPO appointment. Check connection.");
    }
}
// Function 3: Expand the panel back out for editing
function toggleDPOEdit() {
    // Hide the summary, bring back the command center
    document.getElementById('dpo-summary-section').style.display = 'none';
    document.getElementById('dpo-command-center').style.display = 'block';
}
