// O-Harness mobile client — chat-first, reuses client.js persistent ws
(function () {
  var SECRET_KEY = "oh.secret";
  var deviceId = localStorage.getItem("oh.deviceId") || "";
  var sessId = localStorage.getItem("oh.msess") || "main";
  var autoSpeak = localStorage.getItem("oh.autospeak") !== "off";
  var busy = false, streamingMsg = null, asks = [];
  var earliestSeq = 0, loadingEarlier = false, PAGE = 60;

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
    else if (topic === "chat.stream") {
      if (!data || data.sessionId !== sessId) return;
      var n = streamingMsg && streamingMsg.node && streamingMsg.node.isConnected ? streamingMsg.node : null;
      if (!n && data.tok) { var bs = document.querySelectorAll("#chatLog .bubble.assistant"); n = bs[bs.length - 1] || null; }
      if (data.reasoning) { var tn = ensureThink({ node: n }); if (tn) { var pb = tn.querySelector("pre.tb"); if (pb && !pb.textContent) pb.textContent = "…"; } }
      else if (data.tok && n) { var m2 = n.querySelector(".md"); if (m2) { if (m2.textContent === "…" || m2.textContent === "") m2.textContent = data.tok; else m2.textContent += data.tok; } else n.appendChild(Object.assign(document.createElement("div"), { className: "md", textContent: data.tok })); }
    }
    else if (topic === "chat.tool") { if (data && data.sessionId === sessId) { var tn2 = streamingMsg && streamingMsg.node && streamingMsg.node.isConnected ? streamingMsg.node : (document.querySelectorAll("#chatLog .bubble.assistant")[document.querySelectorAll("#chatLog .bubble.assistant").length - 1] || null); if (tn2) toolEvent({ node: tn2 }, data); } }
    else if (topic === "chat.message") { streamingMsg = null; }
    else if (topic === "alert.fired" || topic === "alert.resolved") { if (tabOn("pulse")) loadPulse(); }
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
  function streamMain(m) {
    if (!m || !m.node.isConnected) return;
    var md = m.node.querySelector(".md");
    if (md) md.textContent = m.buf; else m.node.textContent = m.buf;
  }
  function ensureThink(m) {
    if (m.think && m.think.isConnected) return m.think;
    if (!m.node || !m.node.isConnected) return null;
    var ex = m.node.querySelector("details.think");
    if (ex) { m.think = ex; return ex; }
    var det = document.createElement("details");
    det.className = "think";
    det.innerHTML = "<summary>thinking…</summary><pre class=\"tb\"></pre>";
    var first = m.node.querySelector("details.steps");
    if (first) m.node.insertBefore(det, first.parentNode === m.node ? first : null);
    else {
      var ref = m.node.querySelector(".md");
      m.node.insertBefore(det, ref && ref.parentNode === m.node ? ref : (m.node.lastChild || null));
    }
    m.think = det;
    return det;
  }
  function stepLabel(st) {
    var a = st.args || {};
    if (st.tool === "exec" && a.command) { var c = String(a.command).split("\n")[0]; return c.length > 80 ? c.slice(0, 80) + "…" : c }
    if ((st.tool === "read_file" || st.tool === "write_file") && a.path) return st.tool + " " + String(a.path);
    return st.tool + " " + JSON.stringify(a).slice(0, 60);
  }
  function toolEvent(m, d) {
    if (!m || !m.node.isConnected) return;
    var det = m.node.querySelector("details.steps");
    if (!det) {
      det = document.createElement("details");
      det.className = "steps";
      det.open = true;
      det.innerHTML = "<summary>⚙ Ran <span class=\"n\">0</span> step</summary><div class=\"stepsbody\"></div>";
      var ref = m.node.querySelector(".md");
      m.node.insertBefore(det, ref && ref.parentNode === m.node ? ref : (m.node.lastChild || null));
    }
    var body = det.querySelector(".stepsbody");
    if (!body) return;
    var sig = d.tool + "|" + JSON.stringify(d.args || {});
    var rows = body.querySelectorAll(".stepline"); var line = null;
    for (var i = 0; i < rows.length; i++) { if (rows[i].dataset.sig === sig) { line = rows[i]; break } }
    if (d.status === "running") {
      if (!line) { line = document.createElement("div"); line.className = "stepline run"; line.dataset.sig = sig; body.appendChild(line) }
      line.textContent = String.fromCharCode(9892) + " " + stepLabel(d);
      line.title = JSON.stringify(d.args || {});
    } else {
      if (!line) { line = document.createElement("div"); line.className = "stepline"; line.dataset.sig = sig; body.appendChild(line) }
      line.className = "stepline"; line.textContent = stepLabel(d);
      line.title = (JSON.stringify(d.args || {}) + " -> " + String(d.result || "").slice(0, 300));
      var c = det.querySelector("summary .n"); if (c) c.textContent = String(body.querySelectorAll(".stepline").length);
    }
  }
  function stopChat() {
    window.OH.rpc("chat.abort", { sessionId: sessId }).then(function (r) { toast(r && r.ok ? "stopping…" : "not running"); }).catch(function (e) { toast(String(e)); });
  }
  var SLASH = [["help","list commands"],["new","start a new session"],["rename <t>","rename current session"],["thinking <l>","effort: none|low|medium|xhigh"],["models","show configured models"],["memory <q>","search durable memory"],["export","download session markdown"],["pin","pin this session"],["archive","hide this session from the list"],["unarchive","restore an archived session"],["stop","stop generation"]];
  function slashInfo(html) { bubble("assistant", html, "system"); }
  async function slashRun(msg) {
    var sp0 = msg.slice(1).trim();
    var sp = sp0.indexOf(" "); var cmd = (sp < 0 ? sp0 : sp0.slice(0, sp)).toLowerCase(); var arg = sp < 0 ? "" : sp0.slice(sp + 1).trim();
    if (cmd === "help") { slashInfo("<b>slash commands</b><br>" + SLASH.map(function (c) { return "/<b>" + c[0] + "</b> <span class='dim'>" + c[1] + "</span>" }).join("<br>")); return true }
    if (cmd === "new") { var s = await window.OH.rpc("sessions.create", { title: "chat " + new Date().toISOString().slice(11, 16) }); sessId = s.id; localStorage.setItem("oh.msess", s.id); loadSessions(); loadChat(); slashInfo("started session " + esc(String(s.id).slice(0, 8))); return true }
    if (cmd === "rename") { if (!arg) { slashInfo("usage: /rename &lt;title&gt;"); return true } await window.OH.rpc("sessions.rename", { id: sessId, title: arg }); loadSessions(); slashInfo("renamed to <b>" + esc(arg) + "</b>"); return true }
    if (cmd === "thinking") { var lv = arg.toLowerCase(); if (["none","low","medium","xhigh"].indexOf(lv) < 0) { slashInfo("usage: /thinking none|low|medium|xhigh"); return true } localStorage.setItem("oh.effort", lv); slashInfo("effort set to <b>" + lv + "</b>"); return true }
    if (cmd === "models") { var st = await window.OH.rpc("settings.get", {}); var def = (st.default || {}).modelId; var lines = []; (st.providers || []).forEach(function (p) { (p.models || []).forEach(function (mod) { lines.push(mod.id === def ? "<b>" + esc(mod.id) + "</b> (" + esc(p.id) + ")" : esc(mod.id) + " <span class='dim'>" + esc(p.id) + "</span>") }) }); slashInfo(lines.length ? lines.join("<br>") : "no models configured"); return true }
    if (cmd === "memory") { if (!arg) { slashInfo("usage: /memory &lt;query&gt;"); return true } var hits = (await window.OH.rpc("memory.search", { query: arg, limit: 8 })) || []; var out = hits.map(function (h) { var t = (h.memory && h.memory.text) || h.text || ""; return "· " + esc(String(t).slice(0, 160)) }).join("<br>"); slashInfo(hits.length ? out : "no memory matches <i>" + esc(arg) + "</i>"); return true }
    if (cmd === "export") {
      var eu = "/sessions/export?session=" + encodeURIComponent(sessId);
      var tk = window.OH.getToken(); if (tk) eu += "&token=" + encodeURIComponent(tk);
      var secE = localStorage.getItem(SECRET_KEY); if (secE) eu += "&secret=" + encodeURIComponent(secE);
      window.location.href = eu; slashInfo("downloading session…"); return true
    }
    if (cmd === "pin") { var lst = (await window.OH.rpc("sessions.list", {})) || []; var cur = lst.filter(function (x) { return x.id === sessId })[0]; await window.OH.rpc("sessions.pin", { id: sessId, pinned: !(cur && cur.pinned) }); loadSessions(); slashInfo("session " + (cur && cur.pinned ? "unpinned" : "pinned")); return true }
    if (cmd === "archive") { await window.OH.rpc("sessions.archive", { id: sessId, archived: true }); loadSessions(); slashInfo("session archived — use /unarchive to restore"); return true }
    if (cmd === "unarchive") { await window.OH.rpc("sessions.archive", { id: sessId, archived: false }); loadSessions(); slashInfo("session restored"); return true }
    if (cmd === "stop") { stopChat(); slashInfo("stopping…"); return true }
    return false
  }
  async function sendChat() {
    if (busy) {
      var bt = ($("mInput").value || "").trim();
      if (bt.charAt(0) === "/" && /^\/[a-zA-Z]+(\s|$)/.test(bt)) {
        var bh; try { bh = await slashRun(bt); } catch (er2) { toast(String(er2), "err"); return } if (bh) { $("mInput").value = ""; autosize($("mInput")); return };
      }
      stopChat(); return;
    }
    var inp = $("mInput");
    var text = (inp.value || "").trim();
    if (!text) return;
    if (text.charAt(0) === "/" && /^\/[a-zA-Z]+(\s|$)/.test(text)) {
      var handled; try { handled = await slashRun(text); } catch (er) { toast(String(er), "err"); return } if (handled) return;
    }
    busy = true; inp.value = ""; autosize(inp);
    bubble("user", esc(text));
    streamingMsg = null;
    var b = bubble("assistant", "<div class='md'>…</div>");
    streamingMsg = { node: b, buf: "", rbuf: "", think: null };
    var sb = $("mSendBtn"); if (sb) { sb.textContent = "Stop"; sb.title = "stop generation"; }
    window.OH.rpc("chat.send", { sessionId: sessId, message: text, effort: localStorage.getItem("oh.effort") || undefined }).then(function (r) {
      streamingMsg = null;
      var t = r && r.text ? r.text : "";
      var md = b.querySelector(".md"); if (md) md.textContent = t; else b.innerHTML = esc(t);
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
      var shown = list.filter(function (s) { return !ids[s.id] && !s.archived && (s.chat === true || s.chat === undefined || s.id === "main" || (s.entryCount === 0)); });
      if (!shown.length) shown = list.filter(function (s) { return !s.archived }).slice(0, 3);
      var html = "";
      var cur = sessId;
      shown.forEach(function (s) { html += "<option value='" + esc(s.id) + "'" + (s.id === cur ? " selected" : "") + ">" + esc(s.title) + " (" + (s.entryCount || 0) + ")</option>"; });
      if (!shown.some(function (s) { return s.id === cur; })) { sessId = shown.length ? shown[0].id : "main"; localStorage.setItem("oh.msess", sessId); }
      window.__ohSessions = shown;
      var pbn = $("mPinBtn");
      if (pbn) {
        var act = null;
        for (var qi = 0; qi < shown.length; qi++) { if (shown[qi].id === sessId) { act = shown[qi]; break } }
        pbn.textContent = String.fromCharCode(128204);
        pbn.title = (act && act.pinned) ? "unpin" : "pin";
      }
      sel.innerHTML = html || "<option value='main'>main</option>";
    }).catch(function () { });
  }
  function newChat() {
    window.OH.rpc("sessions.create", { title: "mobile " + new Date().toLocaleDateString() }).then(function (s) { sessId = s.id; localStorage.setItem("oh.msess", sessId); loadSessions(); loadChat(); toast("new chat"); });
  }
  function loadChat() {
    $("chatLog").innerHTML = "";
    streamingMsg = null;
    earliestSeq = 0;
    window.OH.rpc("chat.history", { sessionId: sessId, limit: PAGE }).then(function (es) {
      (es || []).forEach(function (e) { buildBubble(e) });
      if (es && es.length >= PAGE) { earliestSeq = es[0].seq; addEarlier(); }
    }).catch(function () { });
  }
  function buildBubble(e) {
      var b = bubble(e.role === "user" ? "user" : "assistant", esc(e.text || ""), (e.seq ? e.seq + " · " + (e.role || "") : ""));
        if (e.role !== "user") {
          var mt = b.querySelector(".meta");
          if (mt) {
            var cp = document.createElement("button"); cp.className = "ghostbtn"; cp.textContent = "copy";
            cp.style.cssText = "margin-left:6px;font-size:11px;padding:1px 7px";
            var txt = e.text || "";
            cp.onclick = function () {
              var ok = false;
              try { ok = document.execCommand ? (function () { var ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select(); var r = false; try { r = document.execCommand("copy") } catch (err) { } ta.remove(); return r })() : false } catch (err) { ok = false }
              if (!ok && navigator.clipboard) { navigator.clipboard.writeText(txt); ok = true }
              if (ok) { cp.textContent = "copied"; setTimeout(function () { cp.textContent = "copy" }, 1500) } else toast("copy failed")
            };
            mt.appendChild(cp);
            var bt = document.createElement("button"); bt.className = "ghostbtn"; bt.textContent = "again";
            bt.style.cssText = "margin-left:6px;font-size:11px;padding:1px 7px";
            bt.onclick = function () { regenChat(); };
            mt.appendChild(bt);
          }
          if (e.reasoning) { ensureThink({ node: b }).querySelector("pre.tb").textContent = e.reasoning; }
          if (e.steps && e.steps.length) {
            var det = document.createElement("details"); det.className = "steps";
            det.innerHTML = "<summary>⚙ Ran <span class=\"n\">" + e.steps.length + "</span> step</summary><div class=\"stepsbody\"></div>";
            e.steps.forEach(function (st) { var ln = document.createElement("div"); ln.className = "stepline"; ln.textContent = stepLabel(st); ln.title = JSON.stringify(st.args || {}); det.querySelector(".stepsbody").appendChild(ln) });
            var mdr = b.querySelector(".md"); if (b.contains(mdr)) b.insertBefore(det, mdr && mdr.parentNode === b ? mdr : b.firstChild);
          }
        }
    return b;
  }
  function addEarlier() {
    if (!earliestSeq || $("mEarlier")) return;
    var b = document.createElement("button");
    b.id = "mEarlier"; b.className = "ghostbtn"; b.textContent = "load earlier messages";
    b.style.cssText = "margin:4px auto;display:block";
    b.onclick = loadEarlier;
    $("chatLog").insertBefore(b, $("chatLog").firstChild);
  }
  function loadEarlier() {
    if (!earliestSeq || loadingEarlier) return;
    loadingEarlier = true;
    var log = $("chatLog"); var prev = log.scrollHeight - log.scrollTop;
    var eb = $("mEarlier"); if (eb) eb.textContent = "loading…";
    window.OH.rpc("chat.history", { sessionId: sessId, limit: PAGE, since: earliestSeq }).then(function (h) {
      if (h && h.length) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < h.length; i++) frag.appendChild(buildBubble(h[i]));
        log.insertBefore(frag, log.firstChild);
        earliestSeq = h.length >= PAGE ? h[0].seq : 0;
      } else earliestSeq = 0;
      var eb2 = $("mEarlier"); if (eb2) eb2.remove();
      if (earliestSeq) addEarlier();
      log.scrollTop = log.scrollHeight - prev;
      loadingEarlier = false;
    }).catch(function () { loadingEarlier = false; });
  }
  function regenChat() {
    if (busy) { stopChat(); return; }
    busy = true;
    var sb = $("mSendBtn"); if (sb) { sb.textContent = "Stop"; sb.title = "stop generation"; }
    streamingMsg = null;
    var asists = document.querySelectorAll("#chatLog .bubble.assistant");
    if (asists.length) asists[asists.length - 1].remove(); // dropped server-side; drop it here too
    var b = bubble("assistant", "<div class='md'>…</div>");
    streamingMsg = { node: b, buf: "", rbuf: "", think: null };
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
        html += "<div class='mrow'><b>" + esc(m.title) + "</b> <span class='badge'>" + esc(m.status) + "</span> <span class='dim'>t" + m.turnsUsed + "/" + m.maxTurns + "</span><br><span class='dim'>" + esc(String(m.result || m.error || "").slice(0, 180)) + "</span>" + ((m.status === "running" || m.status === "queued" || m.status === "waiting") ? "<div style='margin-top:4px'><button class='ghostbtn' data-mkill='" + esc(m.id) + "'>kill</button></div>" : "") + "</div>";
      });
      if (!(list || []).length) html += "<div class='dim'>no minions yet</div>";
      html += "</div>";
      host.innerHTML = html;
      $("mSpawn").onclick = function () {
        var t = $("mTask").value.trim();
        if (!t) { toast("type a task"); return; }
        window.OH.rpc("agents.spawn", { task: t, title: "mobile" }).then(function (m) { toast("spawned " + m.id.slice(0, 8)); loadMinions(); }).catch(function (e) { toast(String(e), "err"); });
      };
      host.querySelectorAll("[data-mkill]").forEach(function (b) { b.onclick = function () {
        if (!confirm("kill this minion?")) return;
        window.OH.rpc("agents.kill", { id: b.dataset.mkill }).then(function (r) { toast(r && r.ok ? "killed" : "not killable", r && r.ok ? "ok" : "err"); loadMinions(); });
      }; });
    }).catch(function (e) { host.innerHTML = "<div class='card'>" + esc(String(e)) + "</div>"; });
  }
  function fmtCad(c) {
    if (!c) return "?";
    if (c.type === "every") return "every " + c.minutes + "m";
    if (c.type === "daily") return "daily " + c.time;
    return "once " + new Date(c.at).toLocaleString();
  }
  function loadSched() {
    var host = $("sec-sched");
    if (!host) return;
    window.OH.rpc("schedule.list", {}).then(function (js) {
      var html = "<div class='card'><h3>Scheduled jobs</h3>";
      html += "<div style='margin:4px 0 8px'><button id='mJobNew' class='ghostbtn'>+ new job</button></div>";
      html += "<div id='mJobForm' style='display:none;margin:0 0 10px'>"
        + "<input id='mJobLabel' placeholder='label' style='width:100%'>"
        + "<div style='margin-top:6px'><select id='mJobKind' style='width:100%'><option value='chat'>chat message</option><option value='minion'>minion task</option></select></div>"
        + "<div id='mJobSessRow' style='margin-top:6px'><select id='mJobSess' style='width:100%'></select></div>"
        + "<textarea id='mJobMsg' placeholder='message…' style='width:100%;margin-top:6px'></textarea>"
        + "<div style='margin-top:6px;display:flex;gap:6px'><select id='mJobCad' style='flex:1'><option value='every'>every…</option><option value='daily'>daily</option><option value='once'>once at</option></select>"
        + "<input id='mJobVal' placeholder='minutes' style='width:90px'></div>"
        + "<div style='margin-top:6px'><button id='mJobGo' class='primary'>create</button></div></div>";
      if (!(js || []).length) html += "<div class='dim'>none yet</div>";
      (js || []).forEach(function (j) {
        html += "<div class='mrow' style='" + (j.disabled ? "opacity:.5" : "") + "'>"
          + "<b>" + esc(j.label || j.id) + "</b> <span class='badge'>" + esc(j.kind) + "</span> <span class='dim'>" + esc(fmtCad(j.cadence)) + "</span>"
          + "<br><span class='dim'>next " + (j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "—") + (j.count ? " · ran " + j.count : "") + "</span>"
          + "<div style='margin-top:4px;display:flex;gap:6px'>"
          + "<button class='ghostbtn' data-srun='" + esc(j.id) + "'>run now</button>"
          + "<button class='ghostbtn' data-sdis='" + esc(j.id) + "'>" + (j.disabled ? "enable" : "disable") + "</button>"
          + "<button class='ghostbtn' data-sdel='" + esc(j.id) + "'>remove</button>"
          + "</div></div>";
      });
      html += "</div>";
      host.innerHTML = html;
      var newBtn = $("mJobNew");
      if (newBtn) newBtn.onclick = function () {
        var f = $("mJobForm"); if (!f) return;
        f.style.display = f.style.display === "none" ? "block" : "none";
      };
      var kindSel = $("mJobKind");
      var sessRow = $("mJobSessRow");
      if (kindSel) kindSel.onchange = function () {
        $("mJobMsg").placeholder = kindSel.value === "minion" ? "task for a minion…" : "message…";
        if (sessRow) sessRow.style.display = kindSel.value === "chat" ? "" : "none";
      };
      window.OH.rpc("sessions.list", {}).then(function (ss) {
        var sel = $("mJobSess");
        if (!sel) return;
        var opts = (ss || []).filter(function (s) { return !s.archived; }).slice(0, 40).map(function (s) {
          return "<option value='" + esc(s.id) + "'" + (s.id === "main" ? " selected" : "") + ">" + esc(s.title) + "</option>";
        }).join("");
        sel.innerHTML = opts || "<option value='main'>main</option>";
      }).catch(function () {});
      var cadSel = $("mJobCad");
      if (cadSel) cadSel.onchange = function () {
        var v = $("mJobVal");
        v.placeholder = cadSel.value === "every" ? "minutes" : (cadSel.value === "daily" ? "HH:MM" : "YYYY-MM-DD HH:MM");
      };
      var go = $("mJobGo");
      if (go) go.onclick = function () {
        var label = $("mJobLabel").value.trim();
        var message = $("mJobMsg").value.trim();
        if (!label || !message) { toast("label + message required", "err"); return; }
        var cadType = cadSel ? cadSel.value : "every";
        var raw = $("mJobVal").value.trim();
        var cadence = null;
        try {
          if (cadType === "every") {
            var mins = Math.max(1, Math.round(Number(raw) || 60));
            cadence = { type: "every", minutes: mins };
          } else if (cadType === "daily") {
            if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(raw)) throw new Error("bad time");
            cadence = { type: "daily", time: raw };
          } else {
            var at = Date.parse(raw.replace(" ", "T"));
            if (!at) throw new Error("bad date");
            cadence = { type: "once", at: new Date(at).toISOString() };
          }
        } catch (err) { toast("cadence: " + String(err.message || err), "err"); return; }
        var jkind = $("mJobKind") ? $("mJobKind").value : "chat";
        var sess = $("mJobSess") ? $("mJobSess").value : "main";
        window.OH.rpc("schedule.create", { label: label, message: jkind === "chat" ? message : undefined, task: jkind === "minion" ? message : undefined, sessionId: jkind === "chat" ? sess : undefined, cadence: cadence }).then(function (r) {
          toast(r && r.id ? "job created" : "error", r && r.id ? "ok" : "err");
          loadSched();
        }).catch(function (er) { toast(String(er), "err"); });
      };
      host.querySelectorAll("[data-srun]").forEach(function (b) { b.onclick = function () { window.OH.rpc("schedule.runNow", { id: b.dataset.srun }).then(function (r) { toast(r && r.ok ? "ran" : "unknown job", r && r.ok ? "ok" : "err"); loadSched(); }); }; });
      host.querySelectorAll("[data-sdis]").forEach(function (b) { b.onclick = function () {
        var cur = (window.__ohJobs || []).filter(function (x) { return x.id === b.dataset.sdis })[0];
        window.OH.rpc("schedule.setDisabled", { id: b.dataset.sdis, disabled: !(cur && cur.disabled) }).then(function () { loadSched(); });
      }; });
      host.querySelectorAll("[data-sdel]").forEach(function (b) { b.onclick = function () {
        if (!confirm("remove job?")) return;
        window.OH.rpc("schedule.remove", { id: b.dataset.sdel }).then(function (r) { toast(r && r.ok ? "removed" : "unknown job", "ok"); loadSched(); });
      }; });
    }).catch(function () { });
    window.OH.rpc("schedule.list", {}).then(function (js) { window.__ohJobs = js || []; });
  }
  function loadMemory() {
    var host = $("sec-memory");
    window.OH.rpc("memory.list", { limit: 50 }).then(function (ms) {
      var html = "<div class='card'><h3>Search</h3><input id='mmQ' placeholder='search memory…'><button id='mSearch' class='primary' style='width:100%'>Search</button></div>";
      html += "<div class='card'><h3>Add</h3><input id='mmAdd' placeholder='remember this…' style='width:100%'><div style='margin-top:6px;display:flex;gap:6px'><button id='mmSave' class='ghostbtn'>save</button><button id='mmCons' class='ghostbtn'>consolidate</button></div></div>";
      html += "<div class='card'><h3>Recent</h3>";
      (ms || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 40).forEach(function (m) {
        html += "<div class='mrow'><b>" + esc(m.subject || "") + "</b> <span class='badge'>" + esc(m.layer || "") + "</span> <span class='dim'>" + Math.round((m.importance || 0) * 100) + "%</span><br><span>" + esc(m.text || "") + "</span><div style='margin-top:4px'><button class='ghostbtn' data-mdel='" + esc(m.id || "") + "'>forget</button></div></div>";
      });
      html += "</div>";
      host.innerHTML = html;
      function wireRows() {
        host.querySelectorAll("[data-mdel]").forEach(function (b) { b.onclick = function () {
          if (!confirm("forget this memory?")) return;
          window.OH.rpc("memory.forget", { id: b.dataset.mdel }).then(function (r) {
            toast(r && r.ok ? "forgotten (kept for history)" : "unknown memory id", r && r.ok ? "ok" : "err");
            loadMemory();
          });
        }; });
      }
      function wireCards() {
        var sv = $("mmSave"); if (sv) sv.onclick = function () {
          var t = $("mmAdd").value.trim(); if (!t) return;
          window.OH.rpc("memory.add", { text: t, subject: "user" }).then(function () { $("mmAdd").value = ""; toast("saved"); loadMemory(); });
        };
        var cn = $("mmCons"); if (cn) cn.onclick = function () {
          window.OH.rpc("memory.consolidate", {}).then(function (r) { toast("consolidated " + ((r && r.memoriesChecked) || 0) + " memories", "ok"); loadMemory(); });
        };
        var sb = $("mSearch"); if (sb) sb.onclick = function () {
          var q = $("mmQ").value;
        window.OH.rpc("memory.search", { query: q, limit: 30 }).then(function (hits) {
          var h = "<div class='card'>";
          (hits || []).forEach(function (x) {
            var m = x.memory || x;
            h += "<div class='mrow'><b>" + esc(m.subject || "") + "</b> <span class='dim'>" + Math.round((x.score || 0) * 100) + "%</span><br>" + esc(m.text || "") + "<div style='margin-top:4px'><button class='ghostbtn' data-mdel='" + esc(m.id || "") + "'>forget</button></div></div>";
          });
          if (!(hits || []).length) h += "<div class='dim'>no hits</div>";
          h += "</div>";
          host.innerHTML = html + h;
          wireRows(); wireCards();
        });
      };
      }
      wireRows(); wireCards();
    }).catch(function (e) { host.innerHTML = "<div class='card'>" + esc(String(e)) + "</div>"; });
  }

  function loadAsks() {
    var host = $("sec-tools");
    Promise.all([window.OH.rpc("tools.pending", {}).catch(function () { return [] }), window.OH.rpc("grants.list", {}).catch(function () { return [] }), window.OH.rpc("device.tools.list", {}).catch(function () { return [] })]).then(function (res) {
      var grants = res[1] || [];
      var offered = res[2] || [];
      asks = res[0] || [];
      var html = "<div class='card'>";
      asks.forEach(function (a) {
        html += "<div class='mrow'><b>" + esc(a.tool) + "</b> <span class='dim'>by " + esc(String(a.requester || "")) + " on " + esc(String(a.deviceId || "").slice(0, 8)) + "</span><br><span class='dim'>" + esc(JSON.stringify(a.args || {}).slice(0, 160)) + "</span><br><button data-yes='" + esc(a.id) + "'>Approve</button> <button data-rem='" + esc(a.id) + "'>Always</button> <button class='ghost' data-no='" + esc(a.id) + "'>Deny</button></div>";
      });
      if (!asks.length) html += "<div class='dim'>no pending asks</div>";
      html += "</div><div class='card'><h3>Standing grants</h3>";
      if (grants.length) {
        grants.forEach(function (gr) {
          html += "<div class='mrow'><b>" + esc(gr.tool) + "</b> <span class='dim'>device " + esc(String(gr.deviceId).slice(0, 8)) + "</span><div style='margin-top:4px'><button class='ghostbtn' data-grev='" + esc(String(gr.deviceId)) + "|" + esc(String(gr.tool)) + "'>revoke</button></div></div>";
        });
      } else {
        html += "<div class='dim'>none — use Always on an approval to grant one</div>";
      }
      html += "</div><div class='card'><h3>Devices offering tools</h3>";
      if (offered.length) {
        offered.forEach(function (o) {
          var names = (o.tools || []).map(function (t) { return typeof t === "string" ? t : t.name; });
          html += "<div class='mrow'><b>" + esc(String(o.deviceId || "").slice(0, 8)) + "</b><br><span class='dim'>" + esc(names.join(", ")) + "</span></div>";
        });
      } else {
        html += "<div class='dim'>no connected device advertises tools</div>";
      }
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

  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function pcard(t, big, sub) {
    return "<div class='card'><h3>" + t + "</h3><div class='big'>" + big + "</div><div class='dim'>" + sub + "</div></div>";
  }
  function inCad(j) {
    if (!j) return "no schedule";
    var d = j.nextRunAt - Date.now();
    if (d < 0) return "now";
    var m = Math.round(d / 60000);
    if (m < 60) return "in " + m + "m";
    var h = Math.round(m / 60);
    if (h < 48) return "in " + h + "h";
    return "in " + Math.round(h / 24) + "d";
  }
  function loadPulse() {
    var host = $("sec-pulse");
    if (!host) return;
    Promise.all([
      window.OH.rpc("monitor.status", {}),
      window.OH.rpc("agents.list", {}),
      window.OH.rpc("devices.list", {}),
      window.OH.rpc("schedule.list", {})
    ]).then(function (rs) {
      var mon = rs[0] || {};
      var minions = rs[1] || [];
      var devs = rs[2] || [];
      var jobs = (rs[3] || []).filter(function (j) { return !j.disabled });
      var running = minions.filter(function (m) { return m.status === "running" || m.status === "queued" || m.status === "waiting" });
      var onlineDev = devs.filter(function (d) { return d.connected }).length;
      var openA = (mon.alerts || []).filter(function (a) { return a.state === "firing" && !a.acked });
      var nextJob = jobs.slice().sort(function (a, b) { return a.nextRunAt - b.nextRunAt })[0];
      var svc = (mon.statuses || []).map(function (s) {
        return "<div class='mrow'>" + (s.ok ? "&#128994; " : "&#128308; ") + "<b>" + esc(s.name) + "</b> <span class='dim'>" + (s.latencyMs != null ? s.latencyMs + "ms" : "-") + (s.consecutiveFails > 1 ? " \u00b7 " + s.consecutiveFails + " fails" : "") + " \u00b7 " + ago(s.checkedAt || 0) + "</span></div>";
      }).join("") || "<div class='dim'>no services probed yet</div>";
      var alertHtml = openA.map(function (a) {
        return "<div class='mrow'>&#128293; <b>" + esc(a.name) + "</b> <span class='dim'>" + esc(String(a.detail || "").slice(0, 60)) + " \u00b7 " + ago(a.at) + "</span><div style='margin-top:4px'><button class='ghostbtn' data-ack='" + esc(String(a.id)) + "'>ack</button></div></div>";
      }).join("") || "<div class='dim'>no open alerts</div>";
      host.innerHTML = "<div class='cards'>" +
        pcard("Minions", running.length ? running.length + " active" : "idle", minions.length + " total") +
        pcard("Devices", onlineDev + " online", devs.length + " registered") +
        pcard("Jobs", String(jobs.length), "next " + inCad(nextJob)) +
        "</div>" +
        "<div class='card'><h3>Alerts</h3>" + alertHtml + "</div>" +
        "<div class='card'><h3>Services <button class='ghostbtn' data-pchk='1' style='float:right'>check now</button></h3>" + svc +
        (mon.lastCheckAt ? "<div class='dim'>last check " + ago(mon.lastCheckAt) + "</div>" : "") + "</div>";
    }, function (e) { host.innerHTML = "<div class='dim'>error: " + esc(String(e)) + "</div>" });
  }
  function tabOn(name) { var b = document.querySelector("#mNav button[data-tab='" + name + "']"); return b && b.classList.contains("on"); }
  function showTab(name) {
    document.querySelectorAll("#mNav button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === name); });
    document.querySelectorAll(".msec").forEach(function (s) { s.classList.toggle("on", s.id === "sec-" + name); });
    if (name === "pulse") loadPulse();
    else if (name === "minions") loadMinions();
    else if (name === "sched") loadSched();
    else if (name === "memory") loadMemory();
    else if (name === "tools") loadAsks();
    else if (name === "me") showMe();
  }
  function showMe() {
    var id = localStorage.getItem("oh.deviceId") || "(token session)";
    $("meDevice").textContent = "device " + id + " — notes/calendar stored locally in this browser";
    window.OH.rpc("devices.list", {}).then(function (devs) {
      var peers = (devs || []).filter(function (d) { return String(d.id) !== String(id); });
      $("mePeers").innerHTML = peers.length ? peers.map(function (d) {
        return "<div class='mrow'><b>" + esc(d.name || d.id) + "</b> <span class='dim'>" + esc(d.kind || "") + "</span> <span class='dim'>" + (d.connected ? "online" : "offline") + "</span></div>";
      }).join("") : "<div class='dim'>no other devices registered</div>";
    }).catch(function () { $("mePeers").innerHTML = "<div class='dim'>unavailable</div>"; });
    window.OH.rpc("pairing.list", {}).then(function (ps) {
      $("mePairs").innerHTML = (ps || []).length ? (ps || []).map(function (p) {
        return "<div class='mrow'><b>" + esc(p.name) + "</b> <span class='dim'>" + esc(p.kind || "") + "</span> <span class='dim'>" + (p.revokedAt ? "revoked" : ((p.scopes || []).join(",") || "active")) + "</span>" + (p.revokedAt ? "" : "<div style='margin-top:4px'><button class='ghostbtn' data-mprev='" + esc(String(p.id)) + "'>revoke pairing</button></div>") + "</div>";
      }).join("") : "<div class='dim'>no pairings</div>";
    }).catch(function () { $("mePairs").innerHTML = "<div class='dim'>unavailable</div>"; });
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
    $("mSessions").onchange = function () { sessId = this.value; localStorage.setItem("oh.msess", sessId); loadChat(); loadSessions(); };
    function curSession() { var A = window.__ohSessions || []; for (var i = 0; i < A.length; i++) { if (A[i].id === sessId) return A[i] } return null; }
    async function liveSession() {
      try {
        var A = await window.OH.rpc("sessions.list", {});
        var hit = (A || []).filter(function (s) { return s.id === sessId })[0];
        if (hit) { window.__ohSessions = A.filter(function (s) { return !s.archived }); }
        return hit || curSession();
      } catch (e) { return curSession(); }
    }
    $("mPinBtn").onclick = async function () {
      var s = await liveSession();
      if (!s) { toast("open a chat first"); return; }
      try { await window.OH.rpc("sessions.pin", { id: s.id, pinned: !s.pinned }); toast(s.pinned ? "unpinned" : "pinned", "ok"); loadSessions(); } catch (e) { toast(String(e)); }
    };
    $("mRenBtn").onclick = async function () {
      var s = await liveSession();
      if (!s) { toast("open a chat first"); return; }
      var t = prompt("session title", s.title || "");
      if (t && t.trim()) { try { await window.OH.rpc("sessions.rename", { id: s.id, title: t.trim() }); toast("renamed", "ok"); loadSessions(); } catch (e) { toast(String(e)); } }
    };
    function showSearchBox(on) {
      var box = $("mSearchBox"); if (!box) return;
      box.style.display = on ? "flex" : "none";
      if (on) { $("mQ").focus(); } else { $("mHits").innerHTML = ""; }
    }
    function runSearch() {
      var q = $("mQ").value.trim();
      if (!q) { $("mHits").innerHTML = ""; return; }
      window.OH.rpc("sessions.search", { q: q, limit: 20 }).then(function (hits) {
        var h = "";
        (hits || []).forEach(function (x) {
          h += "<div class='mrow'><b>" + esc(x.title) + "</b> <span class='dim'>" + x.hits + " hits · seq " + x.matchSeq + "</span><br>"
            + "<span class='dim'>" + esc(x.snippet.slice(0, 90)) + (x.snippet.length > 90 ? "…" : "") + "</span>"
            + "<div style='margin-top:4px'><button class='ghostbtn' data-hit='" + esc(x.id) + "'>open</button></div></div>";
        });
        $("mHits").innerHTML = h || "<div class='dim' style='padding:6px 2px'>no hits for “" + esc(q) + "”</div>";
        document.querySelectorAll("#mHits [data-hit]").forEach(function (b) {
          b.onclick = function () {
            sessId = b.dataset.hit; localStorage.setItem("oh.msess", sessId);
            showSearchBox(false); loadSessions(); loadChat();
          };
        });
      }).catch(function (e) { toast(String(e), "err"); });
    }
    $("mSrBtn").onclick = function () { showSearchBox($("mSearchBox").style.display !== "flex"); };
    $("mQGo").onclick = runSearch;
    $("mQX").onclick = function () { showSearchBox(false); };
    $("mQ").addEventListener("keydown", function (ev) { if (ev.key === "Enter") runSearch(); });
    $("mDelBtn").onclick = async function () {
      var s = await liveSession();
      if (!s) { toast("open a chat first"); return; }
      if (s.id === "main") { toast("main cannot be deleted", "err"); return; }
      if (!confirm("delete '" + (s.title || s.id) + "' (" + (s.entryCount || 0) + " entries)? not recoverable")) return;
      try {
        var r = await window.OH.rpc("sessions.delete", { id: s.id });
        if (r && r.ok) { toast("deleted", "ok"); sessId = "main"; localStorage.setItem("oh.msess", "main"); loadSessions(); loadChat(); }
        else toast("delete refused", "err");
      } catch (e) { toast(String(e)); }
    };
    $("mMicBtn").onclick = micToggle;
    $("mSpeakBtn").onclick = function () { autoSpeak = !autoSpeak; localStorage.setItem("oh.autospeak", autoSpeak ? "on" : "off"); this.classList.toggle("on", autoSpeak); };
    $("mSpeakBtn").classList.toggle("on", autoSpeak);
    $("mUnpairBtn").onclick = unpair;
    document.querySelectorAll("#mNav button").forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });
    document.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest("[data-yes],[data-rem],[data-no],[data-a],[data-grev],[data-mprev],[data-ack],[data-pchk]");
      if (t && t.dataset.mprev) {
        if (confirm("revoke this pairing?")) window.OH.rpc("pairing.revoke", { id: t.dataset.mprev }).then(function () { toast("pairing revoked"); showMe(); });
        return;
      }
      if (t && t.dataset.pchk) {
        window.OH.rpc("monitor.check", {}).then(function () { toast("services checked"); loadPulse(); }, function (e9) { toast(String(e9), "err"); });
        return;
      }
      if (t && t.dataset.ack) {
        window.OH.rpc("alerts.ack", { id: t.dataset.ack }).then(function () { toast("alert acked"); loadPulse(); });
        return;
      }
      if (t && t.dataset.grev) {
        var parts = t.dataset.grev.split("|");
        window.OH.rpc("grants.revoke", { deviceId: parts[0], tool: parts[1] }).then(function () { toast("revoked"); loadAsks(); }, function (e9) { toast(String(e9), "err"); });
        return;
      }
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
