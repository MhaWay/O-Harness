// single-file Web UI — served at / when the gateway listens on loopback
export const WEBUI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>O-Harness</title>
<style>
:root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --border:#262b36; --tx:#e6e9ef; --dim:#8a93a6; --acc:#4c8dff; --ok:#3fb950; --bad:#f56c6c; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--tx); }
header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); }
header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
header .spacer { flex:1 }
.badge { font-size:12px; padding:2px 8px; border-radius:99px; border:1px solid var(--border); color:var(--dim); }
.badge.live { color:var(--ok); border-color:var(--ok); }
main { max-width:1060px; margin:0 auto; padding:18px; display:grid; grid-template-columns:170px 1fr; gap:18px; }
nav { display:flex; flex-direction:column; gap:4px; }
nav button { text-align:left; background:none; color:var(--dim); border:0; padding:8px 10px; border-radius:8px; cursor:pointer; font:inherit; }
nav button.on { background:var(--panel); color:var(--tx); }
section { display:none } section.on { display:block }
.card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px; margin-bottom:14px; }
.card h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
table { width:100%; border-collapse:collapse; font-size:13px }
th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); }
th { color:var(--dim); font-weight:500; }
input,select,textarea { background:#0c0e12; color:var(--tx); border:1px solid var(--border); border-radius:6px; padding:6px 8px; font:inherit; }
textarea { width:100%; min-height:84px; font-family:ui-monospace,monospace; font-size:12px; }
button.act { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:7px 12px; cursor:pointer; font:inherit; }
button.ghost { background:none; border:1px solid var(--border); color:var(--tx); border-radius:6px; padding:6px 10px; cursor:pointer; font:inherit; }
button.danger { background:none; border:1px solid var(--bad); color:var(--bad); border-radius:6px; padding:4px 8px; cursor:pointer; font-size:12px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0; }
.dim { color:var(--dim) }
.ok { color:var(--ok) } .bad { color:var(--bad) }
.provider { border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:12px }
.provider .head { display:flex; align-items:center; gap:10px }
.provider .head input { flex:1 }
.hidden { display:none }
#toast { position:fixed; bottom:16px; right:16px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 14px; display:none }
pre { white-space:pre-wrap; word-break:break-all; background:#0c0e12; padding:10px; border-radius:8px; border:1px solid var(--border); font-size:12px }
</style>
</head>
<body>
<header>
  <h1>O&#8209;Harness</h1>
  <span class="badge" id="modeBadge">local</span>
  <span class="spacer"></span>
  <input id="tokenBox" type="password" placeholder="gateway token" style="width:200px">
  <span class="badge live" id="connBadge">disconnected</span>
</header>
<main>
  <nav>
    <button data-tab="overview" class="on">Overview</button>
    <button data-tab="sessions">Sessions</button>
    <button data-tab="minions">Minions</button>
    <button data-tab="devices">Devices</button>
    <button data-tab="tools">Tools</button>
    <button data-tab="chat">Chat</button>
    <button data-tab="sched">Scheduler</button>
<button data-tab="memory">Memory</button>
<button data-tab="settings">Settings</button>
  </nav>
  <div>
    <section id="tab-overview" class="on">
      <div class="card"><h2>Gateway</h2><pre id="ovHealth">…</pre></div>
      <div class="card"><h2>Models default</h2><div class="row" id="ovDefault">…</div></div>
    </section>
    <section id="tab-devices">
      <div class="card"><h2>Devices</h2>
        <div class="row"><button class="act" onclick="loadDevices()">Refresh</button></div>
        <table><thead><tr><th>id</th><th>name</th><th>kind</th><th>status</th><th>transport</th></tr></thead>
        <tbody id="devRows"></tbody></table>
      </div>
      <div class="card"><h2>Pairing</h2>
        <div class="row">
          <input id="pairKind" placeholder="kind (mobile/remote)" style="max-width:150px">
          <button class="act" onclick="createPairCode()">Create code</button>
        </div>
        <div id="pairOut" class="dim">no active code</div>
        <table style="margin-top:8px"><thead><tr><th>id</th><th>name</th><th>kind</th><th>scopes</th><th>last seen</th><th></th></tr></thead>
        <tbody id="pairRows"></tbody></table>
        <div class="row" style="margin-top:12px;border-top:1px solid #333;padding-top:10px">
          <span class="dim">This browser:</span><span id="selfPair" class="dim">not paired</span>
          <input id="selfCode" placeholder="paste 6-digit code" style="max-width:140px" maxlength="6">
          <button class="act" onclick="pairThisBrowser()">Pair</button>
          <button class="ghost" onclick="forgetThisBrowser()">forget</button>
        </div>
      </div>
    </section>
    <section id="tab-tools">
      <div class="card"><h2>Pending tool approvals</h2>
        <div class="row"><button class="act" onclick="loadTools()">Refresh</button><span class="dim">auto-refresh while this tab is open</span></div>
        <table style="margin-top:8px"><thead><tr><th>id</th><th>device</th><th>tool</th><th>args</th><th>requester</th><th></th></tr></thead>
        <tbody id="askRows"></tbody></table>
      </div>
      <div class="card"><h2>Standing grants</h2>
        <table style="margin-top:8px"><thead><tr><th>device</th><th>tool</th><th>last used</th><th></th></tr></thead>
        <tbody id="grantRows"></tbody></table>
      </div>
    </section>
    <section id="tab-sessions">
      <div class="card"><h2>Sessions</h2>
        <div class="row">
          <button class="act" onclick="loadSessions()">Refresh</button>
          <input id="newTitle" placeholder="new session title">
          <button class="ghost" onclick="createSession()">Create</button>
        </div>
        <select id="sessSelect" onchange="loadSessionDetail()" style="width:100%"></select>
        <pre id="sessDetail" style="margin-top:10px">select a session…</pre>
      </div>
    </section>
    <section id="tab-minions">
      <div class="card"><h2>Dispatch a task</h2>
        <div class="row"><textarea id="minTask" placeholder="Describe the task for the minion..." style="min-height:60px"></textarea></div>
        <div class="row">
          <input id="minTitle" placeholder="title (optional)" style="flex:1">
          <select id="minEffort"><option value="none">thinking: none</option><option value="low">low</option><option value="medium">medium</option><option value="xhigh">xhigh</option></select>
          <input id="minTurns" type="number" placeholder="max turns" value="12" style="width:90px">
          <button class="act" onclick="spawnMinion()">Dispatch</button>
        </div>
      </div>
      <div class="card"><h2>Minions</h2>
        <div class="row"><button class="act" onclick="loadMinions()">Refresh</button><span class="dim">auto-refresh while this tab is open</span></div>
        <table><thead><tr><th>id</th><th>title</th><th>status</th><th>turns</th><th>result / error</th><th></th></tr></thead>
        <tbody id="minRows"></tbody></table>
      </div>
    </section>
    <section id="tab-chat">
      <div class="card"><h2>Chat</h2>
        <div class="row"><select id="chatSession" onchange="loadChat()" style="flex:1"></select><button class="act" onclick="loadChat()">Reload</button></div>
        <pre id="chatLog" style="margin-top:10px;max-height:340px;overflow:auto">loading…</pre>
        <div class="row"><input id="chatInput" placeholder="say something to O-Harness…" style="flex:1"><button class="act" onclick="sendChat()">Send</button></div>
        <div class="row"><span class="dim" id="chatStatus"></span></div>
      </div>
    </section>
    <section id="tab-sched">
      <div class="card"><h2>Scheduled jobs</h2>
        <div class="row"><input id="sLabel" placeholder="label" style="width:160px">
        <input id="sMsg" placeholder="message (empty = minion task field below)" style="flex:1;min-width:220px"><input id="sTask" placeholder="minion task (if message empty)" style="flex:1;min-width:220px"></div>
        <div class="row"><select id="sCad" onchange="showCad()"><option value="every">every (min)</option><option value="daily">daily (HH:mm)</option><option value="once">once (ISO)</option></select>
        <input id="sEvery" type="number" value="60" style="width:90px"><input id="sDaily" placeholder="09:00" class="hidden"><input id="sOnce" placeholder="2026-12-01T08:00" class="hidden" style="flex:1"></div>
        <div class="row"><button class="act" onclick="addSched()">+ Schedule job</button><button class="ghost" onclick="loadSched()">Reload</button><span class="dim" id="schedStatus"></span></div>
        <table class="t"><thead><tr><th>id</th><th>next</th><th>kind</th><th>label</th><th>last</th><th></th></tr></thead><tbody id="schedRows"><tr><td colspan="6" class="dim">loading…</td></tr></tbody></table>
      </div>
    </section>
    <section id="tab-memory">
      <div class="card"><h2>Memory</h2>
        <div class="row"><input id="mQuery" placeholder="search memory…" style="flex:1;min-width:220px">
        <input id="mSubject" placeholder="subject (optional)" style="width:180px">
        <button class="act" onclick="searchMemory()">Search</button>
        <button class="ghost" onclick="searchMemory('')">All</button></div>
        <div class="row"><input id="mAdd" placeholder="remember a fact…" style="flex:1;min-width:280px">
        <button class="act" onclick="addMemory()">+ Remember</button>
        <button class="ghost" onclick="consMemory()">Consolidate</button>
        <span class="dim" id="memStatus"></span></div>
        <table class="t"><thead><tr><th>score</th><th>subject</th><th>layer</th><th>text</th><th>valid</th><th>age</th></tr></thead><tbody id="memRows"><tr><td colspan="6" class="dim">type something and Search, or All</td></tr></tbody></table>
      </div>
    </section>
    <section id="tab-settings">
      <div class="card"><h2>Models</h2>
        <div id="providers"></div>
        <div class="row">
          <button class="act" onclick="openAdd()">+ Add provider</button>
          <button class="ghost" onclick="openAdd(true)">Add custom (IP/link)</button>
        </div>
        <div id="addForm" class="hidden" style="border-top:1px solid var(--border); padding-top:10px; margin-top:10px">
          <div class="row">
            <input id="pName" placeholder="provider name">
            <input id="pUrl" placeholder="API ip/link  e.g. http://127.0.0.1:8000/v1" style="flex:1; min-width:280px">
            <input id="pKey" placeholder="api key (optional)" type="password" style="width:180px">
          </div>
          <div class="row">
            <button class="act" onclick="fetchModels()">Fetch models</button>
            <span id="fetchInfo" class="dim"></span>
          </div>
          <div class="row"><select id="fetchedSel" size="8" multiple style="flex:1; min-width:280px"></select>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="ghost" onclick="selAll()">select all</button>
            <button class="ghost" onclick="addCustom()">+ custom model id</button>
            <input id="customModel" placeholder="model id">
          </div></div>
          <div class="row"><span class="dim">Selected models:</span><span id="picked" class="dim">none</span>
            <button class="ghost" onclick="picked.length=0;renderPicked()">clear</button></div>
          <div class="row"><span class="dim">Extra settings (json):</span></div>
          <textarea id="pExtra">{}</textarea>
          <div class="row"><button class="act" onclick="saveProvider()">Save provider</button>
          <button class="ghost" onclick="closeAdd()">cancel</button></div>
        </div>
        <div class="card" style="margin-top:14px"><h2>Default model</h2>
          <div class="row">
            <select id="defProvider" onchange="fillDefaultModels()"></select>
            <select id="defModel"></select>
            <select id="defEffort">
              <option value="none">thinking: none</option><option value="low">thinking: low</option>
              <option value="medium">thinking: medium</option><option value="xhigh">thinking: xhigh</option>
            </select>
            <button class="act" onclick="saveDefault()">Set default</button><button class="ghost" onclick="testDefault()">Test</button><span id="testInfo" class="dim"></span>
          </div>
          <div class="row"><label><input type="checkbox" id="allowUpdate" onchange="saveAllow()"> allow self-update (when valid/necessary)</label></div>
          <div class="row"><button class="ghost" onclick="checkUpdates()">Check for updates now</button><span id="updInfo" class="dim"></span></div>
        </div>
      </div>
      <div class="card"><h2>Config.json</h2>
        <div class="row"><button class="act" onclick="loadSettingsJson()">Reload</button>
        <span class="dim">full settings (providers, defaults, extra)</span></div>
        <textarea id="settingsJson" style="min-height:220px"></textarea>
        <div class="row"><button class="act" onclick="saveSettingsJson()">Save</button><span id="settingsMsg"></span></div>
      </div>
    </section>
  </div>
</main>
<div id="toast"></div>
<script>
const EFF=[ 'none','low','medium','xhigh' ];
let token = localStorage.getItem('oh.token') || new URLSearchParams(location.search).get('token') || '';
document.getElementById('tokenBox').value = token;
document.getElementById('tokenBox').addEventListener('change', e => { token = e.target.value.trim(); localStorage.setItem('oh.token', token); ping(); });
let settings = null, providers = [], picked = [], editingId = null;
const $ = (id) => document.getElementById(id);
const toast = (msg, ok) => { const t = $('toast'); t.textContent = msg; t.style.border = '1px solid ' + (ok === false ? 'var(--bad)' : 'var(--ok)'); t.style.display='block'; setTimeout(()=>t.style.display='none', 3500); };

function wsRpc(method, params) {
  return new Promise((res, rej) => {
    const ws = new WebSocket((location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/api?token=' + encodeURIComponent(token));
    const id = 'web-' + Math.random().toString(36).slice(2);
    const t = setTimeout(()=>{ ws.close(); rej(new Error('rpc timeout '+method)); }, 25000);
    ws.onopen = () => ws.send(JSON.stringify({type:'rpc:req',id,method,params}));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type==='rpc:res' && m.id===id){ clearTimeout(t); ws.close(); m.error!==undefined?rej(new Error(m.error)):res(m.result); } };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws error — check token/gateway')); };
  });
}
function ping(){ wsRpc('devices.list').then(()=>{ $('connBadge').textContent='connected'; $('connBadge').className='badge live'; return true; }).catch(e=>{ $('connBadge').textContent='disconnected'; $('connBadge').className='badge'; }); }
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('section').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); $('tab-'+b.dataset.tab).classList.add('on');
  if (b.dataset.tab==='settings') loadSettingsTab();
  if (b.dataset.tab==='memory') searchMemory('');
  if (b.dataset.tab==='devices') { loadDevices(); loadPairing(); }
  if (b.dataset.tab==='tools') { loadTools(); if(!askTimer) askTimer=setInterval(loadTools,3000); } else if (askTimer){ clearInterval(askTimer); askTimer=null; }
  if (b.dataset.tab==='sessions') loadSessions();
  if (b.dataset.tab==='chat') loadChat();
  if (b.dataset.tab==='sched') loadSched();
  if (b.dataset.tab==='minions') { loadMinions(); if(!minTimer) minTimer=setInterval(loadMinions,3000); } else if (minTimer){ clearInterval(minTimer); minTimer=null; }
  if (b.dataset.tab==='overview') loadOverview();
});

async function loadOverview(){
  try { const r = await fetch('/health'); $('ovHealth').textContent = JSON.stringify(await r.json(), null, 2); } catch(e){ $('ovHealth').textContent = 'gateway unreachable'; }
  try { const s = await wsRpc('settings.get',{}); const d = s.default && s.default.providerId;
    if (d) { const p = s.providers.find(x=>x.id===d.providerId); const m = p && p.models.find(x=>x.id===d.modelId);
      $('ovDefault').innerHTML = p && m ? '<b>'+esc(p.name)+' / '+esc(m.id)+'</b> &nbsp;<span class="dim">thinking: '+ (d.effort||'none') +' · '+esc(p.baseUrl)+'</span>' : '<span class="bad">default points nowhere</span>'; }
    else $('ovDefault').innerHTML = '<span class="dim">no default set</span>';
  } catch(e){ $('ovDefault').textContent = String(e); }
}
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
async function loadChat(){
  try {
    const ss = await wsRpc('sessions.list', {});
    let minionIds = new Set();
    try { const ag = await wsRpc('agents.list', {}); (ag.minions || ag || []).forEach(function(m){ minionIds.add(m.id); if (m.sessionId) minionIds.add(m.sessionId); }); } catch(e){}
    const shown = ss.filter(function(s){ if (minionIds.has(s.id)) return false; return s.id === 'main' || s.chat === true || s.chat === undefined; });
    const sel = $('chatSession');
    const cur = sel.value;
    sel.innerHTML = shown.map(function(s){ return '<option value=' + esc(s.id) + '>' + esc(s.title) + '</option>'; }).join('');
    if (cur && [...sel.options].some(function(o){ return o.value === cur; })) sel.value = cur;
    else if (!cur && [...sel.options].some(function(o){ return o.value === 'main'; })) sel.value = 'main';
    const h = await wsRpc('chat.history', { sessionId: (sel.value || 'main') });
    $('chatLog').innerHTML = (h && h.length) ? h.map(function(e){ return '<b>' + esc(e.role) + '</b> ' + esc(e.text) + (e.tools ? ' <span style="color:#8af;font-size:.8em">[used: ' + e.tools.map(esc).join(', ') + ']</span>' : ''); }).join('<br>') : '(no messages yet)';
  } catch(e){ toast(String(e), false); }
}
var streamLive = null;
function sendChat(){
  const t = $('chatInput').value.trim();
  if (!t) return;
  $('chatInput').value = '';
  $('chatStatus').textContent = '…';
  const sid = ($('chatSession') && $('chatSession').value) ? $('chatSession').value : 'main';
  streamLive = { text: '', el: null };
  const ws = new WebSocket((location.protocol==='https:'?'wss':'ws') + '://' + location.host + '/api?token=' + encodeURIComponent(token));
  const id = 'sc-' + Math.random().toString(36).slice(2);
  let settled = false;
  const done = (err)=>{ if (settled) return; settled = true; clearTimeout(T); try{ws.close();}catch(e){}
    streamLive = null; $('chatStatus').textContent = '';
    if (err) toast(String(err), false);
    loadChat();
  };
  const T = setTimeout(()=>done('chat timeout'), 300000);
  ws.onopen = () => ws.send(JSON.stringify({type:'rpc:req',id,method:'chat.send',params:{sessionId:sid,message:t}}));
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    if (m.type==='event' && m.topic==='chat.stream' && m.data && m.data.sessionId===sid) {
      if (!streamLive) return;
      if (m.data.reasoning) { $('chatStatus').textContent = 'thinking…'; return; }
      streamLive.text += String(m.data.tok || '');
      $('chatStatus').textContent = '';
      if (!streamLive.el) {
        const log = $('chatLog');
        if (log.textContent === '(no messages yet)') log.innerHTML = '';
        const d = document.createElement('div');
        d.innerHTML = '<b>assistant</b> ';
        const span = document.createElement('span'); span.id = 'streamText';
        d.appendChild(span); log.appendChild(d);
        streamLive.el = span;
      }
      streamLive.el.textContent = streamLive.text;
      const log = $('chatLog'); log.scrollTop = log.scrollHeight;
    }
    else if (m.type==='rpc:res' && m.id===id) { done(m.error!==undefined ? new Error(m.error) : null); }
  };
  ws.onerror = () => done(new Error('ws error'));
}
document.addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.target && e.target.id === 'chatInput') sendChat(); });

async function loadPairing(){
  try { const list = await wsRpc('pairing.list',{});
    $('pairRows').innerHTML = list.map(d=>
      '<tr><td>'+esc(d.id)+'</td><td>'+esc(d.name)+'</td><td>'+esc(d.kind)+'</td><td>'+esc(d.revokedAt?'REVOKED':d.scopes.join(','))+'</td><td class="dim">'+esc(d.lastSeenAt? new Date(d.lastSeenAt).toLocaleString():'-')+'</td>'+
      '<td>'+(d.revokedAt?'':'<button class="ghost" data-act="revpair" data-id="'+esc(d.id)+'">revoke</button>')+'</td></tr>').join('') || '<tr><td colspan="6" class="dim">nothing paired</td></tr>';
  } catch(e){ $('pairRows').innerHTML = '<tr><td colspan="6" class="bad">'+esc(String(e))+'</td></tr>'; }
}
async function createPairCode(){
  try { const c = await wsRpc('pairing.create',{ kind: $('pairKind').value.trim() || 'mobile', scopes: ['read','write'] });
    $('pairOut').innerHTML = 'code <b>'+esc(c.code)+'</b> — expires in '+Math.round((c.expiresAt-Date.now())/60000)+' min'; toast('pairing code '+c.code);
  } catch(e){ toast(String(e),false); }
}
async function revokePair(id){ try { await wsRpc('pairing.revoke',{id}); toast('revoked '+id); loadPairing(); } catch(e){ toast(String(e),false); } }

async function loadDevices(){
  try { const list = await wsRpc('devices.list'); $('devRows').innerHTML = list.map(d=>
    '<tr><td>'+esc(d.id)+'</td><td>'+esc(d.name)+'</td><td>'+esc(d.kind)+'</td><td>'+esc(d.status)+'</td><td>'+esc(d.meta&&d.meta.transport)+'</td></tr>').join('');
  } catch(e){ $('devRows').innerHTML = '<tr><td colspan="5" class="bad">'+esc(String(e))+'</td></tr>'; }
}
async function loadSessions(){
  const list = await wsRpc('sessions.list');
  $('sessSelect').innerHTML = list.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.title)+' ('+ (s.entries?s.entries.length:'?') +')</option>').join('');
  if (list[0]) loadSessionDetail();
}
async function loadSessionDetail(){
  const id = $('sessSelect').value; if (!id) return;
  const s = await wsRpc('sessions.get', {id});
  $('sessDetail').textContent = s.entries.map(e=>e.seq+' ['+new Date(e.ts).toISOString().slice(0,19)+'] '+e.from+' '+e.kind+': '+JSON.stringify(e.data)).join('\\n') || '(empty)';
}
function createSession(){ wsRpc('sessions.create',{title: $('newTitle').value||'new'}).then(()=>{ toast('created'); loadSessions(); }).catch(e=>toast(String(e),false)); }

async function loadSettingsTab(){
  settings = await wsRpc('settings.get',{});
  providers = settings.providers || [];
  renderProviders(); fillDefaultSelects();
  $('allowUpdate').checked = !!settings.allowSelfUpdate;
  $('settingsJson').value = JSON.stringify(settings, null, 2);
}
function renderProviders(){
  $('providers').innerHTML = providers.map((p,i)=>
   '<div class="provider"><div class="head"><input value="'+esc(p.name)+'" onchange="renameName('+i+',this.value)">'+
   '<input value="'+esc(p.baseUrl)+'" onchange="renameUrl('+i+',this.value)" style="max-width:340px">'+
   '<button class="ghost" onclick="editProvider('+i+')">edit</button>'+
   '<button class="danger" onclick="delProvider('+i+')">remove</button></div>'+
   '<div class="dim" style="margin-top:4px">'+p.models.length+' model(s): '+p.models.map(m=>esc(m.id)).join(', ')+'</div></div>').join('');
}
function renameName(i,v){ providers[i].name=v; persist(); }
function renameUrl(i,v){ providers[i].baseUrl=v; persist(); }
async function persist(){ try { await wsRpc('settings.save',{settings:{...settings,providers}}); toast('saved'); } catch(e){ toast(String(e),false); } }
function delProvider(i){ const p=providers[i]; if(!confirm('remove '+p.name+'?'))return; providers.splice(i,1); settings.providers=providers; persist().then(renderProviders); }
function editProvider(i){ openAdd(false); const p=providers[i]; editingId=p.id; $('pName').value=p.name; $('pUrl').value=p.baseUrl; $('pKey').value=p.apiKey||''; $('pExtra').value=JSON.stringify(p.extra||{},null,2); picked=p.models.map(m=>m.id); renderPicked(); $('addForm').classList.remove('hidden'); }
function openAdd(custom){ editingId=null; $('addForm').classList.remove('hidden'); $('pName').value=custom?'custom':'My Provider'; $('pUrl').value=custom?'http://':''; $('pKey').value=''; picked=[]; renderPicked(); }
function closeAdd(){ $('addForm').classList.add('hidden'); }
function selAll(){ $('fetchedSel').selectedOptions.length; Array.from($('fetchedSel').options).forEach(o=>o.selected=true); collect(); }
function collect(){ picked = [...$('fetchedSel').selectedOptions].map(o=>o.value); renderPicked(); }
$('fetchedSel') && ($('fetchedSel').addEventListener('change', collect));
function addCustom(){ const v=$('customModel').value.trim(); if(v){ picked.push(v); $('customModel').value=''; renderPicked(); } }
function renderPicked(){ $('picked').textContent = picked.length? picked.join(', ') : 'none'; $('fetchedSel') && Array.from($('fetchedSel').options).forEach(o=>o.selected = picked.includes(o.value)); }
async function fetchModels(){
  $('fetchInfo').textContent='fetching…';
  try { const models = await wsRpc('models.fetch',{ baseUrl:$('pUrl').value, apiKey:$('pKey').value||undefined });
    $('fetchedSel').innerHTML = models.map(m=>'<option>'+esc(m)+'</option>').join('');
    $('fetchInfo').textContent = models.length + ' models fetched — select/add below';
  } catch(e){ $('fetchInfo').textContent=''; toast(String(e),false); }
}
async function saveProvider(){
  const p = { id: editingId || $('pName').value.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
    name: $('pName').value, baseUrl: $('pUrl').value,
    models: picked.map(id=>({id, reasoningEfforts: EFF})),
    extra: tryJson($('pExtra').value) };
  if ($('pKey').value) p.apiKey = $('pKey').value;
  const existing = editingId ? providers.find(x=>x.id===editingId) : null;
  if (existing) Object.assign(existing, p); else providers.push(p);
  settings.providers = providers; await persist(); closeAdd(); renderProviders(); toast('provider saved');
}
function tryJson(s){ try { return JSON.parse(s||'{}'); } catch(e){ toast('extra must be valid json',false); throw e; } }
function fillDefaultSelects(){
  $('defProvider').innerHTML = providers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  fillDefaultModels();
  if (settings.default){ const i = providers.findIndex(p=>p.id===settings.default.providerId); if(i>=0) $('defProvider').value=settings.default.providerId; fillDefaultModels();
    $('defModel').value = settings.default.modelId; $('defEffort').value = settings.default.effort||'none'; }
}
function fillDefaultModels(){ const p = providers[providers.findIndex(x=>x.id===$('defProvider').value)] || providers[0];
  $('defModel').innerHTML = (p?p.models:[]).map(m=>'<option>'+esc(m.id)+'</option>').join(''); }
async function saveDefault(){ const providerId=$('defProvider').value, modelId=$('defModel').value, effort=$('defEffort').value;
  await wsRpc('settings.save',{settings:{...settings, providers, default:{providerId,modelId,effort}}}); toast('default model set'); loadOverview(); }
async function saveAllow(){ await wsRpc('settings.save',{settings:{...settings, providers, allowSelfUpdate:$('allowUpdate').checked}}); toast('saved'); }
async function testDefault(){ $('testInfo').textContent='testing…'; try { const r = await wsRpc('models.test',{providerId:$('defProvider').value, modelId:$('defModel').value, effort:$('defEffort').value}); $('testInfo').innerHTML='<span class="ok">reply: '+esc(r.text.slice(0,80))+' · '+r.usage.total_tokens+' tok</span>'; } catch(e){ $('testInfo').innerHTML='<span class="bad">'+esc(String(e))+'</span>'; } }
async function checkUpdates(){ $('updInfo').textContent='git pull…'; try { const r = await wsRpc('self.update',{}); $('updInfo').innerHTML='<span class="ok">'+esc(r.stdout.trim()||'done')+'</span>'; } catch(e){ $('updInfo').innerHTML='<span class="bad">'+esc(String(e))+'</span>'; } }
function loadSettingsJson(){ $('settingsJson').value = JSON.stringify(settings, null, 2); }
async function saveSettingsJson(){ try { settings = JSON.parse($('settingsJson').value); await wsRpc('settings.save',{settings}); providers=settings.providers||[]; renderProviders(); fillDefaultSelects(); $('settingsMsg').innerHTML='<span class="ok">saved</span>'; } catch(e){ $('settingsMsg').innerHTML='<span class="bad">'+esc(String(e))+'</span>'; } }

let minTimer = null, minDetail = null;
async function loadMinions(){
  try { const list = await wsRpc('agents.list',{});
    $('minRows').innerHTML = list.map(m =>
      '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.title)+'</td><td class="'+(m.status==='done'?'ok':(m.status==='error'||m.status==='killed')?'bad':'dim')+'">'+esc(m.status)+'</td>'+
      '<td>'+m.turnsUsed+'/'+m.maxTurns+'</td><td style="max-width:340px">'+esc(m.result? String(m.result).slice(0,140): (m.error? '!'+m.error : ''))+'</td>'+
      '<td><button class="ghost" data-act="show" data-id="'+esc(m.id)+'">show</button> '+
      ((m.status==='running'||m.status==='queued')?'<button class="danger" data-act="kill" data-id="'+esc(m.id)+'">kill</button>':'')+'</td></tr>'
    ).join('') || '<tr><td colspan="6" class="dim">no minions</td></tr>';
  } catch(e){ $('minRows').innerHTML = '<tr><td colspan="6" class="bad">'+esc(String(e))+'</td></tr>'; }
}
async function spawnMinion(){
  const task = $('minTask').value.trim(); if(!task){ toast('task required',false); return; }
  try { const m = await wsRpc('agents.spawn',{ task, title: $('minTitle').value.trim() || undefined, effort: $('minEffort').value, maxTurns: Number($('minTurns').value)||12 });
    toast('dispatched '+m.id); $('minTask').value=''; $('minTitle').value=''; loadMinions();
  } catch(e){ toast(String(e),false); }
}
async function showMinion(id){
  try { const m = await wsRpc('agents.get',{id});
    $('minRows').innerHTML += '<tr><td colspan="6"><pre style="max-height:260px;overflow:auto">['+esc(m.status)+'] '+esc(m.title)+'\\n'+esc(m.task)+'\\n\\n'+(m.entries||[]).map(e=>e.seq+' ['+e.kind+'] '+esc(JSON.stringify(e.data).slice(0,500))).join('\\n')+'</pre></td></tr>';
  } catch(e){ toast(String(e),false); }
}
async function killMinion(id){ try { await wsRpc('agents.kill',{id}); toast('killed '+id); loadMinions(); } catch(e){ toast(String(e),false); } }

let askTimer = null;
async function loadTools(){
  try {
    const [asks, grants] = await Promise.all([wsRpc('tools.pending'), wsRpc('grants.list')]);
    $('askRows').innerHTML = (asks.length?asks.map(a=>
      '<tr><td>'+esc(a.id)+'</td><td>'+esc(a.deviceId)+'</td><td>'+esc(a.tool)+'</td><td><code>'+esc(JSON.stringify(a.args||{}).slice(0,80))+'</code></td><td>'+esc(a.requester)+'</td><td>'+
      '<button class="act" data-act="toolyes" data-id="'+esc(a.id)+'">approve</button> '+
      '<button class="ghost" data-act="toolrem" data-id="'+esc(a.id)+'">approve & always</button> '+
      '<button class="danger" data-act="toolno" data-id="'+esc(a.id)+'">deny</button></td></tr>').join(''):'<tr><td colspan="6" class="dim">none</td></tr>');
    $('grantRows').innerHTML = (grants.length?grants.map(g=>
      '<tr><td>'+esc(g.deviceId)+'</td><td>'+esc(g.tool)+'</td><td>'+esc(g.lastUsedAt?new Date(g.lastUsedAt).toLocaleString():'-')+'</td><td>'+
      '<button class="danger" data-act="revgrant" data-id="'+esc(g.deviceId)+'" data-tool="'+esc(g.tool)+'">revoke</button></td></tr>').join(''):'<tr><td colspan="4" class="dim">none</td></tr>');
  } catch(e){ $('askRows').innerHTML = '<tr><td colspan="6" class="bad">'+esc(String(e))+'</td></tr>'; }
}
async function toolRespond(id, approved, remember){ try { await wsRpc('tools.respond',{id,approved,remember}); toast(approved?'approved '+id:'denied '+id); loadTools(); } catch(e){ toast(String(e),false); } }

document.addEventListener('click', (ev) => {
  const t = ev.target.closest && ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
  if (act === 'show') showMinion(id);
  else if (act === 'revpair') revokePair(id);
  else if (act === 'kill') killMinion(id);
  else if (act === 'toolyes') toolRespond(id, true, false);
  else if (act === 'toolrem') toolRespond(id, true, true);
  else if (act === 'toolno') toolRespond(id, false, false);
  else if (act === 'revgrant') { const dt = t.getAttribute('data-tool'); wsRpc('grants.revoke',{deviceId:id, tool:dt}).then(()=>{toast('grant revoked');loadTools();}).catch(e=>toast(String(e),false)); }
});
ping(); loadOverview(); setInterval(ping, 15000);
function showCad(){ for (const id of ['sEvery','sDaily','sOnce']) $(id).classList.add('hidden'); const v=$('sCad').value; if(v==='every') $('sEvery').classList.remove('hidden'); else if(v==='daily') $('sDaily').classList.remove('hidden'); else $('sOnce').classList.remove('hidden'); }
async function loadSched(){ try{ const rows = await wsRpc('schedule.list'); $('schedRows').innerHTML = rows.map(j => '<tr><td>'+esc(j.id)+'</td><td>'+(j.disabled?'<span class=dim>disabled</span>':new Date(j.nextRunAt).toLocaleString())+'</td><td>'+esc(j.kind)+'</td><td>'+esc(j.label||'')+'</td><td class=dim>'+esc(String(j.lastResult||'').slice(0,50))+'</td><td><button class=ghost data-act=schedrun data-id='+esc(j.id)+'>run</button> <button class=ghost data-act=schedtoggle data-id='+esc(j.id)+' data-d='+(j.disabled?'0':'1')+'>'+(j.disabled?'enable':'disable')+'</button> <button class=ghost data-act=schedrm data-id='+esc(j.id)+'>rm</button></td></tr>').join('') || '<tr><td colspan=6 class=dim>no jobs</td></tr>'; } catch(e){ $('schedRows').innerHTML='<tr><td colspan=6 class=dim>'+esc(String(e.message||e))+'</td></tr>'; } }
async function addSched(){ const label=$('sLabel').value.trim(); const message=$('sMsg').value.trim(); const task=$('sTask').value.trim(); const cad=$('sCad').value; let cadence=null;
  if(cad==='every') cadence={type:'every',minutes:Number($('sEvery').value)}; else if(cad==='daily') cadence={type:'daily',time:$('sDaily').value.trim()||'09:00'}; else { const t=Date.parse($('sOnce').value); if(!t){ $('schedStatus').textContent='bad date'; return; } cadence={type:'once',at:new Date(t).toISOString()}; }
  try { await wsRpc('schedule.create',{label:label||undefined,message:message||undefined,task:task||undefined,cadence}); $('schedStatus').textContent='scheduled'; loadSched(); } catch(e){ $('schedStatus').textContent='error: '+e.message; } }
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if(!b) return; const act=b.dataset.act, id=b.dataset.id; if(act==='schedrun'){ wsRpc('schedule.runNow',{id}).then(loadSched); } else if(act==='schedtoggle'){ wsRpc('schedule.setDisabled',{id,disabled:b.dataset.d==='1'}).then(loadSched); } else if(act==='schedrm'){ wsRpc('schedule.remove',{id}).then(loadSched); } });

async function searchMemory(q){
  const query = (q !== undefined) ? q : $('mQuery').value.trim();
  const subject = $('mSubject').value.trim();
  try {
    const hits = await wsRpc('memory.search', { query, subject: subject || undefined, limit: 50 });
    const rows = (hits || []).map(function(h){
      const m = h.memory || h;
      const age = Math.max(0, Math.round((Date.now() - m.createdAt) / 86400000));
      return '<tr><td>' + (h.score != null ? h.score.toFixed(2) : '') + '</td><td>' + esc(m.subject || '') + '</td><td>' + esc(m.layer || '') + '</td><td>' + esc(m.text) + (m.supersededBy ? ' <span class="dim">(superseded)</span>' : '') + '</td><td>' + esc(new Date(m.validFrom).toISOString().slice(0,10)) + '</td><td>' + age + 'd</td></tr>';
    }).join('');
    $('memRows').innerHTML = rows || '<tr><td colspan="6" class="dim">no results</td></tr>';
    $('memStatus').textContent = (hits || []).length + ' hits';
  } catch(e){ toast(String(e), false); }
}
async function addMemory(){
  const t = $('mAdd').value.trim();
  if (!t) return;
  try {
    await wsRpc('memory.add', { text: t, subject: 'user' });
    $('mAdd').value = '';
    $('memStatus').textContent = 'remembered';
    searchMemory($('mQuery').value.trim());
  } catch(e){ toast(String(e), false); }
}
async function consMemory(){
  $('memStatus').textContent = 'consolidating…';
  try {
    const r = await wsRpc('memory.consolidate', {});
    const merged = (r.clusters || []).filter(function(c){ return c.merged; }).length;
    $('memStatus').textContent = 'checked ' + (r.memoriesChecked || 0) + ' memories, merged ' + merged + ' clusters';
    searchMemory($('mQuery').value.trim());
  } catch(e){ toast(String(e), false); $('memStatus').textContent = ''; }
}

async function pairThisBrowser(){
  const code = $('selfCode').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('need a 6-digit code', false); return; }
  try {
    const r = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'dashboard-browser' }) });
    const j = await r.json();
    if (!j.ok) { toast('pair failed: ' + (j.error || 'unknown'), false); return; }
    localStorage.setItem('oh.secret', j.secret);
    $('selfCode').value = '';
    renderSelfPair();
    toast('paired as device ' + j.deviceId);
    loadDevices(); loadPairing();
  } catch(e){ toast(String(e), false); }
}
function forgetThisBrowser(){ localStorage.removeItem('oh.secret'); renderSelfPair(); toast('secret forgotten'); }
function renderSelfPair(){
  const sec = localStorage.getItem('oh.secret');
  $('selfPair').textContent = sec ? ('paired (secret stored locally, ending ...' + sec.slice(-4) + ')') : 'not paired';
}
renderSelfPair();
</script>
</body>
</html>`;
