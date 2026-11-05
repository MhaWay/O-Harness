// O-Harness mobile client — chat-first, reuses client.js persistent ws
(function () {
  var SECRET_KEY = "oh.secret";
  var deviceId = localStorage.getItem("oh.deviceId") || "";
  var sessId = localStorage.getItem("oh.msess") || "main";
  var autoSpeak = localStorage.getItem("oh.autospeak") !== "off";
  var busy = false, streamingMsg = null, asks = [];

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function toast(m, kind) {
    var t = document.createElement("div"); t.className = "toast " + (kind || ""); t.textContent = m;
    var box = document.getElementById("toasts"); if (!box) { return; }
    box.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function setSt(cls, txt) { var b = document.getElementById("mSt"); if (b) { b.className = "badge " + cls; b.textContent = txt; } }
  function $(id) { return document.getElementById(id); }
  function autosize(el) { el.style.height = "auto"; el.style.height = Math.min(140, el.scrollHeight) + "px"; }

  window.OH.onDeviceReq = function (m) { handleDeviceReq(m); };
  window.OH.onEvent = function (topic, data) {
    if (topic === "agents.changed") { if (tabOn("minions")) loadMinions(); }
    else if (topic === "tools.ask") { showAsk(data); }
    else if (topic === "chat.stream") { if (data && data.tok && streamingMsg) { streamingMsg.buf += data.tok; streamingMsg.node.innerHTML = esc(streamingMsg.buf); } }
    else if (topic === "chat.message") { streamingMsg = null; }
  };
  window.OH.onOpen = function () { setSt("ok", "online"); offerTools(); };
  window.OH.onClose = function () { setSt("warn", "offline"); };
  window.OH.authFail = function () { toast("connection refused - unpair and retry", "err"); };

  var localTools = {
    "device.info": function () { return { userAgent: navigator.userAgent, screen: (screen.width || 0) + "x" + (screen.height || 0), online: navigator.onLine, language: navigator.language, time: new Date().toISOString() }; },
    "notes.list": function () { try { return JSON.parse(localStorage.getItem("oh.notes") || "[]"); } catch (e) { return []; } },
    "notes.create": function (a) { var n = localTools["notes.list"](); n.push({ id: String(Date.now()), text: String((a && a.text) || ""), when: String((a && a.when) || ""), createdAt: new Date().toISOString() }); localStorage.setItem("oh.notes", JSON.stringify(n)); return { ok: true, count: n.length }; },
    "notes.search": function (a) { var q = String((a && a.query) || "").toLowerCase(); return localTools["notes.list"]().filter(function (x) { return String(x.text || "").toLowerCase().indexOf(q) >= 0; }); },
    "calendar.list": function () { try { return JSON.parse(localStorage.getItem("oh.cal") || "[]"); } catch (e) { return []; } },
    "calendar.create": function (a) { var c = localTools["calendar.list"](); c.push({ title: String((a && a.title) || ""), when: String((a && a.when) || "") }); localStorage.setItem("oh.cal", JSON.stringify(c)); return { ok: true }; }
  };
  var offered = [
    { name: "device.info", description: "Phone info: browser, screen, online, language, time", parameters: { type: "object", properties: {} } },
    { name: "notes.list", description: "List notes saved on this phone", parameters: { type: "object", properties: {} } },
    { name: "notes.create", description: "Add a note. args: { text: string, when?: string }", parameters: { type: "object", properties: { text: { type: "string" }, when: { type: "string" } }, required: ["text"] } },
    { name: "notes.search", description: "Search notes by substring. args: { query: string }", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "calendar.list", description: "List calendar events saved on this phone", parameters: { type: "object", properties: {} } },
    { name: "calendar.create", description: "Add a calendar event. args: { title: string, when: string }", parameters: { type: "object", properties: { title: { type: "string" }, when: { type: "string" } }, required: ["title"] } }
  ];
  function offerTools() {
    var secret = localStorage.getItem(SECRET_KEY);
    if (!secret) return;
    window.OH.rpc("device.tools.offer", { tools: offered }).catch(function () { });
  }
  function handleDeviceReq(m) {
    var ws = window.OH.ws;
    function reply(ok, val) {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify(ok ? { type: "rpc:res", id: m.id, result: val } : { type: "rpc:res", id: m.id, error: String(val) }));
    }
    var method = m.method, params = m.params || {};
    if (method === "tool.invoke") {
      var fn = localTools[String(params.tool)];
      if (!fn) { reply(false, "unknown device tool"); return; }
      try { reply(true, fn(params.args || {})); } catch (e) { reply(false, String(e)); }
      return;
    }
    reply(false, "mobile device serves only tool.invoke");
  }

  function pair() {
    var code = ($("pairCode").value || "").trim();
    var base = ($("pairBase").value || "").trim();
    var target = base ? base.replace(/\/$/, "").replace(/^ws/, "http") + "/pair" : "pair";
    var err = $("pairErr");
    fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code, name: "mobile browser" }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { err.textContent = j.error || "pair failed"; return; }
        localStorage.setItem(SECRET_KEY, j.secret);
        localStorage.setItem("oh.deviceId", j.deviceId);
        err.textContent = "";
        boot();
      })
      .catch(function (e) { err.textContent = String(e); });
  }
  function unpair() {
    localStorage.removeItem(SECRET_KEY); localStorage.removeItem("oh.deviceId");
    location.href = "/m";
  }

  function bubble(role, html, mline) {
    var log = $("chatLog");
    var b = document.createElement("div"); b.className = "bubble " + role;
    if (mline) { var mt = document.createElement("div"); mt.className = "meta"; mt.textContent = mline; b.appendChild(mt); }
    var md = document.createElement("div"); md.innerHTML = html; b.appendChild(md);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function stopChat() {
    window.OH.rpc("chat.abort", { sessionId: sessId }).then(function (r) { toast(r && r.ok ? "stopping…" : "not running"); }).catch(function (e) { toast(String(e)); });
  }
  function sendChat() {
    if (busy) { stopChat(); return; }
    var inp = $("mInput");
    var text = (inp.value || "").trim();
    if (!text) return;
    busy = true; inp.value = ""; autosize(inp);
    bubble("user", esc(text));
    streamingMsg = null;
    var b = bubble("assistant", "<span class='dim'>…</span>");
    streamingMsg = { node: b, buf: "" };
    var sb = $("mSendBtn"); if (sb) { sb.textContent = "Stop"; sb.title = "stop generation"; }
    window.OH.rpc("chat.send", { sessionId: sessId, message: text }).then(function (r) {
      streamingMsg = null;
      var t = r && r.text ? r.text : "";
      b.innerHTML = esc(t);
      if (autoSpeak && t) speak(t);
    }).catch(function (e) {
      streamingMsg = null;
      b.className = "bubble err"; b.innerHTML = esc(String(e));
    }).then(function () { busy = false; if (sb) { sb.textContent = "Send"; sb.title = "send"; } loadSessions(); });
  }
  function speak(text) {
    var t = String(text).slice(0, 600);
    var u = "/api/voice/tts?text=" + encodeURIComponent(t) + "&token=" + encodeURIComponent(window.OH.getToken());
    var sec = localStorage.getItem(SECRET_KEY); if (sec) u += "&secret=" + encodeURIComponent(sec);
    fetch(u)
      .then(function (r) { return r.blob(); })
      .then(function (b) { var a = new Audio(URL.createObjectURL(b)); a.play().catch(function () { }); })
      .catch(function () { });
  }

  var mrec = null;
  function micToggle() {
    var mb = $("mMicBtn");
    if (mrec) { stopMic(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("no mic access in this browser", "err"); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { toast("no AudioContext", "err"); return; }
    var ctx = new AC({ sampleRate: 16000 });
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var src = ctx.createMediaStreamSource(stream);
      var proc = ctx.createScriptProcessor(4096, 1, 1);
      var chunks = [];
      proc.onaudioprocess = function (e) { chunks.push(e.inputBuffer.getChannelData(0)); };
      src.connect(proc); proc.connect(ctx.destination);
      mb.classList.add("rec");
      mrec = { ctx: ctx, stream: stream, proc: proc, chunks: chunks };
    }).catch(function (e) { toast("mic: " + e, "err"); });
  }
  function stopMic() {
    var mb = $("mMicBtn");
    var rec = mrec; mrec = null;
    if (rec) {
      try { rec.proc.disconnect(); } catch (e) { }
      rec.stream.getTracks().forEach(function (t) { t.stop(); });
      rec.ctx.close();
    }
    mb.classList.remove("rec");
    if (!rec || !rec.chunks.length) return;
    var total = 0; for (var i = 0; i < rec.chunks.length; i++) total += rec.chunks[i].length;
    var out = new Float32Array(total), off = 0;
    for (var k = 0; k < rec.chunks.length; k++) { out.set(rec.chunks[k], off); off += rec.chunks[k].length; }
    toast("transcribing…");
    window.OH.rpc("voice.asr", { audio: b64(encodeWav(out, 16000)) }).then(function (r) {
      var inp = $("mInput");
      inp.value = ((inp.value ? inp.value + " " : "") + ((r && r.text) || "")).trim();
      autosize(inp);
    }).catch(function (e) { toast("asr: " + e, "err"); });
  }
  function encodeWav(samples, rate) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function put(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    put(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); put(8, "WAVE"); put(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(30, 2, true); v.setUint16(32, 16, true);
    put(36, "data"); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
    return new Uint8Array(buf);
  }
  function b64(bytes) { var s = "", a = new Uint8Array(bytes); for (var i = 0; i < a.length; i += 32768) { s += String.fromCharCode.apply(null, Array.prototype.slice.call(a.subarray(i, i + 32768))); } return btoa(s); }

  function loadSessions() {
    var sel = $("mSessions");
    return Promise.all([window.OH.rpc("sessions.list", {}), window.OH.rpc("agents.list", {})]).then(function (rs) {
      var list = rs[0] || [], ms = rs[1] || [];
      var ids = {};
      ms.forEach(function (m) { if (m.sessionId) ids[m.sessionId] = 1; });
      var shown = list.filter(function (s) { return !ids[s.id] && (s.chat === true || s.chat === undefined || s.id === "main"); });
      if (!shown.length) shown = list.slice(0, 3);
      var html = "";
      var cur = sessId;
      shown.forEach(function (s) { html += "<option value='" + esc(s.id) + "'" + (s.id === cur ? " selected" : "") + ">" + esc(s.title) + " (" + (s.entryCount || 0) + ")</option>"; });
      if (!shown.some(function (s) { return s.id === cur; })) { sessId = shown.length ? shown[0].id : "main"; localStorage.setItem("oh.msess", sessId); }
      sel.innerHTML = html || "<option value='main'>main</option>";
    }).catch(function () { });
  }
  function newChat() {
    window.OH.rpc("sessions.create", { title: "mobile " + new Date().toLocaleDateString() }).then(function (s) { sessId = s.id; localStorage.setItem("oh.msess", sessId); loadSessions(); loadChat(); toast("new chat"); });
  }
  function loadChat() {
    $("chatLog").innerHTML = "";
    streamingMsg = null;
    window.OH.rpc("chat.history", { sessionId: sessId }).then(function (es) {
      (es || []).forEach(function (e) {
        var b = bubble(e.role === "user" ? "user" : "assistant", esc(e.text || ""), (e.seq ? e.seq + " · " + (e.role || "") : ""));
        if (e.role !== "user") {
          var bt = document.createElement("button"); bt.className = "ghostbtn"; bt.textContent = "again";
          bt.style.cssText = "margin-left:6px;font-size:11px;padding:1px 7px";
          bt.onclick = function () { regenChat(); };
          var mt = b.querySelector(".meta"); if (mt) mt.appendChild(bt);
        }
      });
    }).catch(function () { });
  }
  function regenChat() {
    if (busy) { stopChat(); return; }
    busy = true;
    var sb = $("mSendBtn"); if (sb) { sb.textContent = "Stop"; sb.title = "stop generation"; }
    streamingMsg = null;
    var b = bubble("assistant", "<span class='dim'>…</span>");
    streamingMsg = { node: b, buf: "" };
    window.OH.rpc("chat.regenerate", { sessionId: sessId }).then(function (r) {
      streamingMsg = null;
      b.innerHTML = esc((r && r.ok) ? (r.text || "") : ((r && r.reason) || "nothing to regenerate"));
    }).catch(function (e) {
      streamingMsg = null;
      b.className = "bubble err"; b.innerHTML = esc(String(e));
    }).then(function () {
      busy = false;
      if (sb) { sb.textContent = "Send"; sb.title = "send"; }
      loadSessions();
    });
  }

  function loadMinions() {
    var host = $("sec-minions");
    window.OH.rpc("agents.list", {}).then(function (list) {
      (list || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
      var html = "<div class='card'><h3>Dispatch a task</h3><textarea id='mTask' rows='2' placeholder='task for a minion…'></textarea><button id='mSpawn' class='primary' style='width:100%'>Spawn</button></div><div class='card'>";
      (list || []).slice(0, 30).forEach(function (m) {
        html += "<div class='mrow'><b>" + esc(m.title) + "</b> <span class='badge'>" + esc(m.status) + "</span> <span class='dim'>t" + m.turnsUsed + "/" + m.maxTurns + "</span><br><span class='dim'>" + esc(String(m.result || m.error || "").slice(0, 180)) + "</span></div>";
      });
      if (!(list || []).length) html += "<div class='dim'>no minions yet</div>";
      html += "</div>";
      host.innerHTML = html;
      $("mSpawn").onclick = function () {
        var t = $("mTask").value.trim();
        if (!t) { toast("type a task"); return; }
        window.OH.rpc("agents.spawn", { task: t, title: "mobile" }).then(function (m) { toast("spawned " + m.id.slice(0, 8)); loadMinions(); }).catch(function (e) { toast(String(e), "err"); });
      };
    }).catch(function (e) { host.innerHTML = "<div class='card'>" + esc(String(e)) + "</div>"; });
  }
  function loadMemory() {
    var host = $("sec-memory");
    window.OH.rpc("memory.list", { limit: 50 }).then(function (ms) {
      var html = "<div class='card'><h3>Search</h3><input id='mQ' placeholder='search memory…'><button id='mSearch' class='primary' style='width:100%'>Search</button></div>";
      html += "<div class='card'><h3>Recent</h3>";
      (ms || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 40).forEach(function (m) {
        html += "<div class='mrow'><b>" + esc(m.subject || "") + "</b> <span class='badge'>" + esc(m.layer || "") + "</span> <span class='dim'>" + Math.round((m.importance || 0) * 100) + "%</span><br><span>" + esc(m.text || "") + "</span></div>";
      });
      html += "</div>";
      host.innerHTML = html;
      $("mSearch").onclick = function () {
        var q = $("mQ").value;
        window.OH.rpc("memory.search", { query: q, limit: 30 }).then(function (hits) {
          var h = "<div class='card'>";
          (hits || []).forEach(function (x) {
            var m = x.memory || x;
            h += "<div class='mrow'><b>" + esc(m.subject || "") + "</b> <span class='dim'>" + Math.round((x.score || 0) * 100) + "%</span><br>" + esc(m.text || "") + "</div>";
          });
          if (!(hits || []).length) h += "<div class='dim'>no hits</div>";
          h += "</div>";
          host.innerHTML = html + h;
        });
      };
    }).catch(function (e) { host.innerHTML = "<div class='card'>" + esc(String(e)) + "</div>"; });
  }
  function loadAsks() {
    var host = $("sec-tools");
    window.OH.rpc("tools.pending", {}).then(function (list) {
      asks = list || [];
      var html = "<div class='card'>";
      asks.forEach(function (a) {
        html += "<div class='mrow'><b>" + esc(a.tool) + "</b> <span class='dim'>by " + esc(String(a.requester || "")) + " on " + esc(String(a.deviceId || "").slice(0, 8)) + "</span><br><span class='dim'>" + esc(JSON.stringify(a.args || {}).slice(0, 160)) + "</span><br><button data-yes='" + esc(a.id) + "'>Approve</button> <button data-rem='" + esc(a.id) + "'>Always</button> <button class='ghost' data-no='" + esc(a.id) + "'>Deny</button></div>";
      });
      if (!asks.length) html += "<div class='dim'>no pending asks</div>";
      html += "</div>";
      host.innerHTML = html;
    }).catch(function (e) { host.innerHTML = "<div class='card'>" + esc(String(e)) + "</div>"; });
  }
  function respondAsk(id, approved, remember) {
    window.OH.rpc("tools.respond", { id: id, approved: approved, remember: remember }).then(function () { toast(approved ? "approved" : "denied"); loadAsks(); }).catch(function (e) { toast(String(e), "err"); });
  }
  function showAsk(ask) {
    if (!ask) return;
    asks.push(ask);
    if (tabOn("tools")) loadAsks();
    var old = document.getElementById("askBanner");
    if (old) old.remove();
    var d = document.createElement("div");
    d.id = "askBanner"; d.className = "banner";
    d.innerHTML = "<b>tool approval</b><br>" + esc(String(ask.requester || "")) + " wants to call <b>" + esc(String(ask.tool || "")) + "</b><br><span class='dim'>" + esc(JSON.stringify(ask.args || {}).slice(0, 120)) + "</span><br><button data-a='1'>Approve</button> <button data-a='2'>Always</button> <button class='ghost' data-a='0'>Deny</button>";
    document.body.appendChild(d);
    setTimeout(function () { if (document.body.contains(d)) { d.remove(); if (lastAskId()) asks = asks.filter(function (x) { return x.id !== lastAskId(); }); } }, 90000);
  }
  function lastAskId() { return asks.length ? asks[asks.length - 1].id : ""; }

  function tabOn(name) { var b = document.querySelector("#mNav button[data-tab='" + name + "']"); return b && b.classList.contains("on"); }
  function showTab(name) {
    document.querySelectorAll("#mNav button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === name); });
    document.querySelectorAll(".msec").forEach(function (s) { s.classList.toggle("on", s.id === "sec-" + name); });
    if (name === "minions") loadMinions();
    else if (name === "memory") loadMemory();
    else if (name === "tools") loadAsks();
    else if (name === "me") showMe();
  }
  function showMe() {
    var id = localStorage.getItem("oh.deviceId") || "(token session)";
    $("meDevice").textContent = "device " + id + " — notes/calendar stored locally in this browser";
  }

  function boot() {
    if (!localStorage.getItem(SECRET_KEY) && !window.OH.getToken()) {
      $("mGate").hidden = false;
      $("mApp").hidden = true;
      return;
    }
    $("mGate").hidden = true;
    $("mApp").hidden = false;
    window.OH.connect();
    setSt("", "connecting…");
    loadSessions();
    loadChat();
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("pairBtn").onclick = pair;
    var code = (location.search.match(/code=(\d{6})/) || [])[1];
    if (code) { $("pairCode").value = code; $("pairBase").hidden = false; }
    boot();
    $("mSendBtn").onclick = sendChat;
    $("mInput").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    $("mInput").addEventListener("input", function () { autosize(this); });
    $("mNewBtn").onclick = newChat;
    $("mSessions").onchange = function () { sessId = this.value; localStorage.setItem("oh.msess", sessId); loadChat(); };
    $("mMicBtn").onclick = micToggle;
    $("mSpeakBtn").onclick = function () { autoSpeak = !autoSpeak; localStorage.setItem("oh.autospeak", autoSpeak ? "on" : "off"); this.classList.toggle("on", autoSpeak); };
    $("mSpeakBtn").classList.toggle("on", autoSpeak);
    $("mUnpairBtn").onclick = unpair;
    document.querySelectorAll("#mNav button").forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });
    document.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest("[data-yes],[data-rem],[data-no],[data-a]");
      if (!t) return;
      if (t.dataset.yes) respondAsk(t.dataset.yes, true, false);
      else if (t.dataset.rem) respondAsk(t.dataset.rem, true, true);
      else if (t.dataset.no) respondAsk(t.dataset.no, false, false);
      else if (t.dataset.a) {
        var id = lastAskId();
        var banner = document.getElementById("askBanner");
        if (id) respondAsk(id, t.dataset.a !== "0", t.dataset.a === "2");
        if (banner) banner.remove();
        asks = asks.filter(function (x) { return x.id !== id; });
      }
    });
  });
})();
