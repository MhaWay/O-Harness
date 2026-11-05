// O-Harness UI app: views, rpc glue, palette
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s) };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)) };
  var NL = String.fromCharCode(10);
  var BT = String.fromCharCode(96);
  var esc = function (s) { return String(s == null ? "" : s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;") };
  var fmtT = function (t) { return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
  var fmtDT = function (t) { return new Date(t).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) };
  var fmtAgo = function (t) { var s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + "m ago"; if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago" };
  var isNum = function (c) { return c >= "0" && c <= "9" };
  var toast = function (msg, kind) {
    var d = document.createElement("div"); d.className = "toast " + (kind || "");
    d.textContent = msg; $("#toasts").appendChild(d);
    setTimeout(function () { if (d.parentNode) d.remove() }, 4000);
  };
  window.toast = toast;
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t); return true }
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy") } catch (err) { ok = false }
    ta.remove(); return ok;
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest(".cpbtn") : null;
    if (!b) return;
    var pre = b.closest("pre"); if (!pre) return;
    var code = pre.querySelector("code"); if (!code) return;
    toast(copyText(code.textContent) ? "code copied" : "copy failed", "");
  });
  function inline(t) {
    t = esc(t);
    while (t.indexOf("**") >= 0) {
      var a = t.indexOf("**"); var b = t.indexOf("**", a + 2);
      if (b < 0) break;
      t = t.slice(0, a) + "<strong>" + t.slice(a + 2, b) + "</strong>" + t.slice(b + 2);
    }
    var parts = t.split(BT); var o = [];
    for (var i = 0; i < parts.length; i++) o.push(i % 2 ? "<code>" + parts[i] + "</code>" : parts[i]);
    t = o.join("");
    var idx = t.indexOf("](");
    var guard = 0;
    while (idx >= 0 && guard++ < 10) {
      var lb = t.lastIndexOf("[", idx); if (lb < 0) break;
      var rb = t.indexOf(")", idx); if (rb < 0) break;
      var label = t.slice(lb + 1, idx); var url = t.slice(idx + 2, rb);
      if (url.indexOf("http") === 0) t = t.slice(0, lb) + '<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>" + t.slice(rb + 1);
      else break;
      idx = t.indexOf("](");
    }
    return t;
  }
  function md(src) {
    if (!src) return "";
    var lines = String(src).split(NL);
    var out = []; var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.slice(0, 3);
      if (fence === "~~~" || fence === BT + BT + BT) {
        i++; var code = [];
        while (i < lines.length && lines[i].slice(0, 3) !== fence) { code.push(lines[i]); i++ }
        i++;
        out.push("<pre class='codeblock'><button class='cpbtn' title='copy code'>copy</button><code>" + esc(code.join(NL)) + "</code></pre>");
        continue;
      }
      var h = 0; while (h < line.length && line[h] === "#") h++;
      if (h >= 1 && h <= 3 && line[h] === " ") { out.push("<h" + (h + 1) + ">" + inline(line.slice(h + 1)) + "</h" + (h + 1) + ">"); i++; continue }
      var t2 = line.trim();
      if ((t2[0] === "-" || t2[0] === "*") && t2.charAt(1) === " ") {
        var items = [];
        while (i < lines.length) {
          var it = lines[i].trim();
          if ((it[0] === "-" || it[0] === "*") && it.charAt(1) === " ") { items.push("<li>" + inline(it.slice(2)) + "</li>"); i++ } else break;
        }
        out.push("<ul>" + items.join("") + "</ul>"); continue;
      }
      if (isNum(t2.charAt(0))) {
        var dot = t2.indexOf(". ");
        if (dot > 0 && dot <= 3) {
          var items2 = [];
          while (i < lines.length) {
            var oit = lines[i].trim(); var d2 = oit.indexOf(". ");
            if (isNum(oit.charAt(0)) && d2 > 0 && d2 <= 3) { items2.push("<li>" + inline(oit.slice(d2 + 2)) + "</li>"); i++ } else break;
          }
          out.push("<ol>" + items2.join("") + "</ol>"); continue;
        }
      }
      if (t2.charAt(0) === ">") {
        var q = [];
        while (i < lines.length && lines[i].trim().charAt(0) === ">") { q.push(inline(lines[i].trim().slice(1).trim())); i++ }
        out.push("<blockquote>" + q.join("<br>") + "</blockquote>"); continue;
      }
      if (!t2) { i++; continue }
      if (t2.charAt(0) === "|") {
        var rows = [];
        while (i < lines.length && lines[i].trim().charAt(0) === "|") { rows.push(lines[i].trim()); i++ }
        if (rows.length > 1) {
          var sep = /^[\s|:-]+$/.test(rows[1].replace(/\|/g, "")) && rows[1].indexOf("-") >= 0;
          function rowCells(r, tag) {
            return "<tr>" + r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return "<" + tag + ">" + inline(c.trim()) + "</" + tag + ">" }).join("") + "</tr>";
          }
          var head = sep ? rowCells(rows[0], "th") : "";
          var rest = sep ? rows.slice(2).map(function (r) { return rowCells(r, "td") }) : rows.map(function (r) { return rowCells(r, "td") });
          out.push("<table class='mdtbl'>" + head + rest.join("") + "</table>");
          continue;
        }
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && lines[i].slice(0, 3) !== "~~~" && lines[i].slice(0, 3) !== BT + BT + BT && lines[i].charAt(0) !== "#" && lines[i].trim().charAt(0) !== "|") { para.push(lines[i]); i++ }
      out.push("<p>" + inline(para.join(" ")) + "</p>");
    }
    return out.join("");
  }
  window.md = md;
  var S = { view: "chat", session: "main", sessions: [], settings: null, minions: [], streaming: null, loaded: false };
  var rpc = window.OH.rpc;
  var views = {
    overview: loadOverview, sessions: loadSessions, minions: loadMinions,
    scheduler: loadScheduler, memory: loadMemory, tools: loadTools,
    devices: loadDevices, settings: loadSettings, logs: loadLogs, chat: null, realtime: loadRealtime
  };
  async function loadLogs() {
  var host = $("#v-logs");
  if (S.logsQ === undefined) S.logsQ = "";
  if (S.logsSrc === undefined) S.logsSrc = "log";
  host.innerHTML = "<h2 class='sec'>Logs</h2>" +
    "<div class='row'><input id='logsQ' placeholder='search... (q)' style='flex:1' value='" + esc(S.logsQ) + "'>" +
    "<select id='logsLevel'><option value=''>all levels</option><option value='debug'>debug</option><option value='info'>info</option><option value='warn'>warn</option><option value='error'>error</option></select>" +
    "<button class='ghost' id='logsGo'>Apply</button><button class='ghost' id='logsAuditBtn'>" + (S.logsSrc === "audit" ? "Show logs" : "Show audit") + "</button><button class='ghost' id='logsResolve'>Ask model to analyze</button><span id='logsOut' class='dim'></span></div>" +
    "<div id='logsStats' class='dim' style='margin:6px 0'></div>" +
    "<pre id='logsList' class='loglist'></pre>";
  var sel = $("#logsLevel"); if (S.logsLevel) sel.value = S.logsLevel;
  var draw = async function () {
    try {
      if (S.logsSrc === "audit") {
        var a = await OH.rpc("logs.audit", { limit: 300, ...(S.logsQ ? { q: S.logsQ } : {}) });
        var evs = a.events.slice().reverse();
        $("#logsList").innerHTML = evs.map(function (ev) {
          var who = ev.actor || (ev.deviceId ? "device " + ev.deviceId : "");
          return esc(new Date(ev.at).toISOString().slice(0, 19).replace("T", " ")) + " " + String(ev.event).toUpperCase() + (who ? " " + esc(String(who)) : "") + (ev.ip ? " ip=" + esc(String(ev.ip)) : "") + (ev.meta ? " " + esc(JSON.stringify(ev.meta)) : "");
        }).join("\n") || "(empty)";
        $("#logsStats").textContent = String(a.events.length) + " audited events (login, pairing, grants, scopes, restores)";
        return;
      }
      var r = await OH.rpc("logs.tail", { limit: 200, ...(S.logsQ ? { q: S.logsQ } : {}), ...(S.logsLevel ? { level: S.logsLevel } : {}) });
      $("#logsList").innerHTML = r.entries.map(function (e) { return esc(new Date(e.ts).toISOString().slice(0, 19).replace("T", " ")) + " " + e.level.toUpperCase() + " [" + e.module + "] " + e.msg + (e.meta ? " " + JSON.stringify(e.meta) : "") }).join("\n") || "(empty)";
      var st = await OH.rpc("logs.stats", undefined);
      $("#logsStats").textContent = st.errors24h + " errors \u00b7 " + st.warns24h + " warnings (24h)" + (st.lastError ? " \u00b7 last: " + st.lastError.module + ": " + String(st.lastError.msg).slice(0, 90) : "") + " \u00b7 " + st.files + " log files";
    } catch (e) { $("#logsList").textContent = "error: " + e.message }
  };
  $("#logsGo").onclick = function () { S.logsQ = $("#logsQ").value; S.logsLevel = $("#logsLevel").value; draw() };
  $("#logsAuditBtn").onclick = function () { S.logsSrc = (S.logsSrc === "audit") ? "log" : "audit"; S.logsQ = $("#logsQ").value; loadLogs(); };
  $("#logsQ").onkeydown = function (ev) { if (ev.key === "Enter") { $("#logsGo").click() } };
  $("#logsResolve").onclick = async function () {
    $("#logsOut").textContent = "analyzing with the model (up to ~1 min)...";
    try { var r = await OH.rpc("logs.resolve", { q: S.logsQ || undefined, level: S.logsLevel || "warn" }); $("#logsOut").textContent = ""; toast("analysis done"); S.logsAnalysis = r.analysis; showLogsAnalysis(); } catch (e) { $("#logsOut").textContent = "error: " + e.message }
  };
  draw();
}
function showLogsAnalysis() {
  var old = document.querySelector("#logsAnalysis"); if (old) old.remove();
  var d = document.createElement("div"); d.id = "logsAnalysis"; d.className = "card"; d.style.marginTop = "10px";
  d.innerHTML = "<h3>Model analysis</h3><div class='md'>" + md(S.logsAnalysis || "") + "</div>";
  var host = $("#v-logs"); if (host) host.appendChild(d);
}
function showView(name) {
    S.view = name;
    $$(".nav button").forEach(function (b) { b.classList.toggle("on", b.dataset.view === name) });
    $$(".view").forEach(function (v) { v.classList.toggle("on", v.id === "v-" + name) });
    $("#viewTitle").textContent = name.charAt(0).toUpperCase() + name.slice(1);
    document.querySelector("#sidebar").classList.remove("open");
    if (views[name]) views[name]();
  }
  function bubble(role, html, extra) {
    var d = document.createElement("div");
    d.className = "bubble " + role;
    if (extra && extra.mline) { var m = document.createElement("div"); m.className = "meta"; m.innerHTML = extra.mline; d.appendChild(m) }
    var b = document.createElement("div"); b.className = "md"; b.innerHTML = html; d.appendChild(b);
    return d;
  }
  var PAGE = 60;
  var chatEarliest = 0;
  var chatLoadingEarlier = false;
  function stepLine(st) {
    var label;
    if (st.tool === "exec" && st.args && st.args.command) label = "exec " + String(st.args.command).split("\n")[0].slice(0, 90);
    else if ((st.tool === "read_file" || st.tool === "write_file") && st.args && st.args.path) label = st.tool + " " + st.args.path;
    else if (st.args && st.args.command) label = st.tool + " " + String(st.args.command).slice(0, 90);
    else label = st.tool;
    return '<div class="stepline" title="' + esc(JSON.stringify(st.args || {})) + '"><span class="stdot"></span>' + esc(label) + "</div>";
  }
  function stepsHost(e) {
    var list = (e.steps && e.steps.length) ? e.steps : (e.tools ? e.tools.map(function (t) { return { tool: t, args: {} }; }) : null);
    if (!list || !list.length) return "";
    var open = list.some(function (s) { return s.status === "running"; });
    return '<details class="steps"' + (open ? " open" : "") + '><summary>' + esc("\u2699") + ' Ran ' + list.length + " step" + (list.length > 1 ? "s" : "") + "</summary><div class='stepsbody'>" + list.map(stepLine).join("") + "</div></details>";
  }
  function bubbleFor(e) {
    var tools = (e.tools || []).map(function (t) { return '<span class="badge">' + esc(t) + "</span>" }).join("");
    var bbl = bubble(e.role, md(e.text), { mline: "<span>" + fmtT(e.ts) + "</span>" + tools });
    var sh = stepsHost(e);
    if (sh) { var d = document.createElement("div"); d.innerHTML = sh; bbl.insertBefore(d.firstChild, bbl.querySelector(".md")); }
    if (e.reasoning) {
      var thk = document.createElement("details"); thk.className = "think";
      thk.innerHTML = "<summary>Thoughts</summary><pre>" + esc(e.reasoning) + "</pre>";
      bbl.insertBefore(thk, bbl.querySelector(".md"));
    }
    if (e.role === "assistant") {
      var mh = bbl.querySelector(".meta");
      if (mh) { addPlay(mh, e.text); addRegen(mh); }
    }
    return bbl;
  }
  function addEarlierBtn() {
    if (!chatEarliest || $("#chatEarlier")) return;
    var b = document.createElement("button");
    b.id = "chatEarlier"; b.className = "ghost"; b.textContent = "Load earlier messages";
    b.onclick = loadEarlier;
    $("#chatLog").insertBefore(b, $("#chatLog").firstChild);
  }
  async function loadEarlier() {
    if (!chatEarliest || chatLoadingEarlier) return;
    chatLoadingEarlier = true;
    var log = $("#chatLog");
    var b1 = $("#chatEarlier"); if (b1) b1.textContent = "loading...";
    var prevScroll = log.scrollHeight - log.scrollTop;
    try {
      var h = await rpc("chat.history", { sessionId: S.session, limit: PAGE, since: chatEarliest });
      if (h && h.length) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < h.length; i++) frag.appendChild(bubbleFor(h[i]));
        log.insertBefore(frag, log.firstChild);
        chatEarliest = h.length >= PAGE ? h[0].seq : 0;
      } else chatEarliest = 0;
    } catch (e) { toast(String(e), "err"); }
    var b2 = $("#chatEarlier");
    if (chatEarliest) { if (b2) b2.textContent = "Load earlier messages"; }
    else if (b2) b2.remove();
    log.scrollTop = log.scrollHeight - prevScroll;
    chatLoadingEarlier = false;
  }
  async function openChat(sessionId) {
    S.session = sessionId;
    renderMiniSessions();
    chatEarliest = 0;
    var log = $("#chatLog"); log.innerHTML = "";
    try {
      var h = await rpc("chat.history", { sessionId: sessionId, limit: PAGE });
      if (!h || !h.length) log.appendChild(bubble("assistant", '<p class="dim">(no messages yet)</p>'));
      else {
        if (h.length >= PAGE) chatEarliest = h[0].seq;
        for (var i = 0; i < h.length; i++) log.appendChild(bubbleFor(h[i]));
        fillHist(h);
      }
      if (chatEarliest) addEarlierBtn();
      log.scrollTop = log.scrollHeight;
    } catch (e) { toast("history: " + e, "err") }
  }
  var SLASH = [
    ["help", "list commands"],
    ["new", "start a new session"],
    ["rename <t>", "rename current session"],
    ["thinking <l>", "effort: none|low|medium|xhigh"],
    ["models", "show configured models"],
    ["memory <q>", "search durable memory"],
    ["export", "download session markdown"],
    ["pin", "pin this session"],
    ["stop", "stop generation"]
  ];
  var slashEls = { menu: null };
  var slashList = [], slashSel = 0;
  function slashInfo(html) { $("#chatLog").appendChild(bubble("assistant", html, { mline: "<span>system</span>" })); var lg = $("#chatLog"); lg.scrollTop = lg.scrollHeight }
  function slashMenuEl() {
    if (!slashEls.menu) { var d = document.createElement("div"); d.className = "slashmenu"; var c = $(".composer"); if (!c) return null; c.appendChild(d); slashEls.menu = d }
    return slashEls.menu
  }
  function slashHide() { var m = slashMenuEl(); if (m) m.style.display = "none" }
  function slashOpen() { var m = slashMenuEl(); return !!m && m.style.display === "block" && slashList.length > 0 }
  function slashRefresh() { var m = slashEls.menu; if (!m) return; $$("div", m).forEach(function (r, i) { r.className = i === slashSel ? "sel" : "" }) }
  function slashMove(d) { if (!slashList.length) return; slashSel = Math.max(0, Math.min(slashList.length - 1, slashSel + d)); slashRefresh() }
  function slashPick(el) { el.value = "/" + slashList[slashSel] + " "; slashHide(); el.focus() }
  function slashCheck(el) {
    var m = slashMenuEl(); if (!m) return;
    var v = el.value;
    if (v.charAt(0) === "/" && !/\s/.test(v)) {
      slashList = SLASH.filter(function (c) { return c[0].indexOf(v.slice(1)) === 0 }).map(function (c) { return c[0] });
      if (!slashList.length) { slashHide(); return }
      slashSel = 0;
      m.innerHTML = slashList.map(function (n, i) {
        var d = SLASH.filter(function (c) { return c[0] === n })[0][1];
        return "<div class='" + (i === slashSel ? "sel" : "") + "' data-scmd='" + n + "'>/" + n + " <span class='dim'>" + d + "</span></div>"
      }).join("");
      $$("div", m).forEach(function (r) { r.onclick = function () { var inp = $("#chatInput"); inp.value = "/" + r.dataset.scmd + " "; slashHide(); inp.focus() } });
      m.style.display = "block";
    } else slashHide();
  }
  async function slashRun(msg, input) {
    var m = msg.match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
    var cmd = m ? m[1].toLowerCase() : "";
    var arg = m && m[2] ? m[2].trim() : "";
    input.value = ""; input.style.height = "auto"; slashHide();
    if (cmd === "help") { slashInfo("<b>slash commands</b><br>" + SLASH.map(function (c) { return "/<b>" + c[0] + "</b> <span class='dim'>" + c[1] + "</span>" }).join("<br>")); return true }
    if (cmd === "new") { var s = await rpc("sessions.create", { title: "chat " + fmtT(Date.now()) }); await loadSessionsCount(); await openChat(s.id); showView("chat"); slashInfo("started session " + esc(String(s.id).slice(0, 8))); return true }
    if (cmd === "rename") { if (!arg) { slashInfo("usage: /rename &lt;title&gt;"); return true } await rpc("sessions.rename", { id: S.session, title: arg }); await loadSessionsCount(); slashInfo("renamed session to <b>" + esc(arg) + "</b>"); return true }
    if (cmd === "thinking") { var lv = arg.toLowerCase(); var sel = $("#effortSel"); if (["none", "low", "medium", "xhigh"].indexOf(lv) < 0 || !sel) { slashInfo("usage: /thinking none|low|medium|xhigh"); return true } sel.value = lv; toast("thinking: " + lv, "ok"); slashInfo("effort set to <b>" + lv + "</b>"); return true }
    if (cmd === "models") { var st = await rpc("settings.get", {}); var lines = []; (st.providers || []).forEach(function (p) { (p.models || []).forEach(function (mod) { lines.push(mod.id === ((st.default || {}).modelId) ? "<b>" + esc(mod.id) + "</b> (" + esc(p.id) + ")" : esc(mod.id) + " <span class='dim'>" + esc(p.id) + "</span>") }) }); slashInfo(lines.length ? lines.join("<br>") : "no models configured"); return true }
    if (cmd === "memory") { if (!arg) { slashInfo("usage: /memory &lt;query&gt;"); return true } var hits = (await rpc("memory.search", { query: arg, limit: 8 })) || []; var out = hits.map(function (h) { var t = (h.memory && h.memory.text) || h.text || ""; return "· " + esc(String(t).slice(0, 160)) }).join("<br>"); slashInfo(hits.length ? out : "no memory matches <i>" + esc(arg) + "</i>"); return true }
    if (cmd === "export") { var a = document.createElement("a"); a.href = "/sessions/export?session=" + encodeURIComponent(S.session) + "&token=" + encodeURIComponent(window.OH.getToken()); a.download = S.session + ".md"; document.body.appendChild(a); a.click(); a.remove(); slashInfo("downloading " + esc(String(S.session)) + ".md"); return true }
    if (cmd === "pin") { var cur = ((S.sessions.filter(function (x) { return x.id === S.session })[0] || {})).pinned; await rpc("sessions.pin", { id: S.session, pinned: !cur }); await loadSessionsCount(); slashInfo(cur ? "unpinned" : "pinned session"); return true }
    if (cmd === "stop") { stopChat(); slashInfo("stop requested"); return true }
    return false
  }
  var sending = false;
  var hist = [], histIdx = -1, histDraft = "";
  function fillHist(h) { hist = []; histIdx = -1; for (var i = 0; i < h.length; i++) { if (h[i].role === "user" && h[i].text) hist.push(h[i].text) } if (hist.length > 200) hist = hist.slice(-200) }
  async function sendChat() {
    var input = $("#chatInput");
    var msg = input.value.trim();
    if (!msg || sending) return;
    if (msg.charAt(0) === "/" && /^\/[a-zA-Z]+(\s|$)/.test(msg)) {
      try { var handled = await slashRun(msg, input) } catch (err) { toast(String(err), "err"); return }
      if (handled) { if (!hist.length || hist[hist.length - 1] !== msg) hist.push(msg); histIdx = -1; return }
    }
    if (!hist.length || hist[hist.length - 1] !== msg) hist.push(msg);
    if (hist.length > 200) hist = hist.slice(-200);
    histIdx = -1; histDraft = "";
    sending = true; var sb = $("#sendBtn"); sb.classList.add("stop"); sb.innerHTML = "&#9632;"; sb.title = "stop generation"; sb.disabled = false;
    input.value = ""; input.style.height = "auto";
    $("#chatLog").appendChild(bubble("user", md(msg), { mline: "<span>you</span>" }));
    var wait = bubble("assistant", '<span class="thinking"><i></i><i></i><i></i></span>', { mline: "<span></span>" });
    var thk = document.createElement("details"); thk.className = "think"; thk.open = true;
    thk.innerHTML = "<summary>Thinking...</summary><pre></pre>";
    wait.insertBefore(thk, wait.querySelector(".md"));
    $("#chatLog").appendChild(wait);
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
    S.think = "";
    S.streaming = wait.querySelector(".md");
    S.streaming.dataset.buf = "";
    try {
      var r = await rpc("chat.send", { sessionId: S.session, message: msg, effort: $("#effortSel").value });
      var replyText = r && r.text ? r.text : String(r || "");
      attachFinal(replyText);
    } catch (e) {
      if (S.streaming) S.streaming.innerHTML = '<span class="dim">error: ' + esc(String(e)) + "</span>";
      toast(String(e), "err");
    }
    S.streaming = null; sending = false; var sb2 = $("#sendBtn"); sb2.classList.remove("stop"); sb2.innerHTML = "&#11014;"; sb2.title = "send"; sb2.disabled = false;
    loadSessionsCount();
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  }
  function stopChat() {
    if (!sending) return;
    toast("stopping…");
    rpc("chat.abort", { sessionId: S.session }).catch(function () { });
  }
  function attachFinal(text) {
    if (!S.streaming) return;
    S.streaming.innerHTML = md(text);
    var parent = S.streaming.parentElement;
    var thk = parent && parent.querySelector("details.think");
    if (thk) { thk.open = false; thk.querySelector("summary").textContent = S.think ? "Thoughts" : "Thinking..."; if (!S.think) thk.remove(); }
    var metaHost = parent && parent.querySelector(".meta");
    if (metaHost) { addPlay(metaHost, text); addRegen(metaHost); }
    if (V.autoSpeak) speakText(text);
  }
  function addRegen(metaHost) {
    var b = document.createElement("button");
    b.className = "ghost"; b.textContent = "again"; b.title = "regenerate this answer";
    b.style.cssText = "margin-left:6px;padding:1px 7px;font-size:11px";
    b.onclick = function () { regenerate(); };
    metaHost.appendChild(b);
  }
  async function regenerate() {
    if (sending) return;
    sending = true;
    var sb = $("#sendBtn"); sb.classList.add("stop"); sb.innerHTML = "&#9632;"; sb.title = "stop generation";
    var log = $("#chatLog");
    var all = log.querySelectorAll(".bubble.assistant");
    var old = all.length ? all[all.length - 1] : null;  // that answer is dropped server-side; drop it in the view too
    if (old) old.remove();
    var wait = bubble("assistant", '<span class="thinking"><i></i><i></i><i></i></span>', { mline: "<span></span>" });
    var thk = document.createElement("details"); thk.className = "think"; thk.open = true;
    thk.innerHTML = "<summary>Thinking...</summary><pre></pre>";
    wait.insertBefore(thk, wait.querySelector(".md"));
    log.appendChild(wait);
    log.scrollTop = log.scrollHeight;
    S.think = "";
    S.streaming = wait.querySelector(".md");
    S.streaming.dataset.buf = "";
    try {
      var r = await rpc("chat.regenerate", { sessionId: S.session, effort: $("#effortSel") ? $("#effortSel").value : undefined });
      if (S.streaming) {
        if (r && r.ok) attachFinal(r.text);
        else S.streaming.innerHTML = '<span class="dim">' + esc(r && r.reason ? r.reason : "nothing to regenerate") + "</span>";
      }
    } catch (e) {
      if (S.streaming) S.streaming.innerHTML = '<span class="dim">error: ' + esc(String(e)) + "</span>";
      toast(String(e), "err");
    }
    S.streaming = null; sending = false;
    var sb2 = $("#sendBtn"); sb2.classList.remove("stop"); sb2.innerHTML = "&#11014;"; sb2.title = "send"; sb2.disabled = false;
    loadSessionsCount();
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  }
  window.regenerate = regenerate;
  window.sendChat = sendChat;

  // ---- Realtime voice (Jarvis mode): persistent mic<->LFM3 relay, live captions ----
  var RT = { ws: null, ctx: null, stream: null, proc: null, play: null, playing: false, micOn: false, started: false, lastUser: "", lastBot: "" };
  function rtWsUrl() { return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/voice?token=" + encodeURIComponent(window.OH.getToken()); }
  function rtLog(txt, cls) {
    var box = $("#rtTranscript"); if (!box) return;
    var d = document.createElement("div"); d.className = "rtline " + (cls || ""); d.innerHTML = txt;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  }
  function rtSetStatus(s) { var el = $("#rtStatus"); if (el) el.textContent = s; }
  function pcm16ToB64(samp) {
    var buf = new Int16Array(samp.length);
    for (var i = 0; i < samp.length; i++) buf[i] = Math.max(-1, Math.min(1, samp[i])) * 32767;
    return window.btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(buf.buffer))));
  }
  function rtPlayB64(b64) {
    try {
      var bin = window.atob(b64); var n = bin.length / 2; var arr = new Int16Array(n);
      for (var i = 0; i < n; i++) arr[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      var ac = RT.ctx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      if (!RT.ctx) RT.ctx = ac;
      var ab = ac.createBuffer(1, n, 24000); ab.getChannelData(0).set(Float32Array.from(arr, function (s) { return s / 32767 }));
      var src = ac.createBufferSource(); src.buffer = ab; src.connect(ac.destination);
      var t0 = RT.playAt && RT.playAt > ac.currentTime ? RT.playAt : ac.currentTime + 0.02;
      src.start(t0); RT.playAt = t0 + ab.duration; RT.playing = true;
      setTimeout(function () { if (!RT.ws) return }, 300);
      src.onended = function () { if (RT.playAt <= ac.currentTime + 0.05) RT.playing = false; };
    } catch (e) { }
  }
  async function rtStart() {
    if (RT.ws) return;
    rtSetStatus("connecting…");
    try {
      RT.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      var micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      RT.micCtx = micCtx;
      var src = micCtx.createMediaStreamSource(RT.stream);
      RT.proc = micCtx.createScriptProcessor(1600, 1, 1);
      RT.proc.onaudioprocess = function (e) {
        if (RT.ws && RT.ws.readyState === 1 && RT.micOn) {
          RT.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16ToB64(e.inputBuffer.getChannelData(0)) }));
        }
      };
      src.connect(RT.proc); RT.proc.connect(micCtx.destination);
    } catch (e) { rtSetStatus("mic unavailable: " + (e.message || e)); return; }
    var ws = new WebSocket(rtWsUrl()); RT.ws = ws; ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      ws.send(JSON.stringify({ type: "session.update", session: { modalities: ["text", "audio"], input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: { type: "server_vad" } } }));
      RT.micOn = true; RT.started = true;
      rtSetStatus("live — speak");
      var mb = $("#rtMicBtn"); if (mb) { mb.classList.add("on"); mb.textContent = "Mic: ON" }
      var st = $("#rtStartBtn"); if (st) st.textContent = "Stop";
      rtLog("<span class='dim'>— session open —</span>", "");
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return }
      if (m.type === "response.audio.delta") { rtPlayB64(m.delta); if (!RT.lastBot) RT.lastBot = " "; }
      else if (m.type === "response.output_audio.done") { RT.playing = false; if (RT.lastBot) { rtLog("🤖 " + esc(RT.lastBot.trim()), "bot"); RT.lastBot = ""; } }
      else if (m.type === "response.audio_transcript.delta") { RT.lastBot += m.delta || ""; }
      else if (m.type === "response.audio_transcript.done") { if (m.transcript) { RT.lastBot = m.transcript } }
      else if (m.type === "conversation.item.input_audio_transcription.completed" && m.transcript) { RT.lastBot = ""; rtLog("🧑 " + esc(m.transcript.trim()), "user"); }
      else if (m.type === "response.output_item.added" && m.item && m.item.type === "message") { }
      else if (m.type === "input_audio_buffer.speech_started") { rtSetStatus("listening…"); RT.playing = false; }
      else if (m.type === "input_audio_buffer.speech_stopped") { rtSetStatus("live — speak"); }
      else if (m.type === "error") { rtSetStatus("server: " + ((m.error && m.error.message) || "error")); }
    };
    ws.onclose = function () {
      rtStopTracks(true);
      RT.ws = null; rtSetStatus("closed");
      var mb2 = $("#rtMicBtn"); if (mb2) mb2.classList.remove("on");
      var st2 = $("#rtStartBtn"); if (st2) st2.textContent = "Start";
    };
    ws.onerror = function () { };
  }
  function rtStopTracks(keepStatus) {
    try { if (RT.proc) RT.proc.disconnect(); } catch (e) { }
    try { if (RT.stream) RT.stream.getTracks().forEach(function (t) { t.stop() }); } catch (e) { }
    try { if (RT.micCtx) RT.micCtx.close(); } catch (e) { }
    RT.proc = null; RT.stream = null; RT.micCtx = null;
    if (!keepStatus) rtSetStatus("stopped");
  }
  function rtStop() {
    if (RT.ws) { try { RT.ws.close(); } catch (e) { } }
    rtStopTracks(false);
    RT.micOn = false;
    var mb = $("#rtMicBtn"); if (mb) { mb.classList.remove("on"); mb.textContent = "Mic: OFF" }
    var st = $("#rtStartBtn"); if (st) st.textContent = "Start";
  }
  function loadRealtime() {
    var host = $("#v-realtime");
    if (!host || host.dataset.built === "1") { return }
    host.dataset.built = "1";
    host.innerHTML = "<h2 class='sec'>Realtime</h2>" +
      "<div class='card' style='margin-bottom:10px'>" +
      "<div class='row' style='align-items:center'>" +
      "<button class='ghost' id='rtStartBtn'>Start</button>" +
      "<button class='ghost' id='rtMicBtn' disabled>Mic: OFF</button>" +
      "<button class='ghost' id='rtStopBtn'>Stop</button>" +
      "<span id='rtStatus' class='dim'>offline</span>" +
      "<span style='flex:1'></span>" +
      "<label style='display:flex;gap:6px;align-items:center'><input id='rtSaveChat' type='checkbox'>save transcript to chat</label>" +
      "</div>" +
      "<div class='dim' style='margin-top:6px'>Direct speech conversation through the LFM3 realtime server (server-side VAD — just talk). While live, the gateway stays supervisable from the other tabs; mic mutes without stopping the session.</div></div>" +
      "<div class='card'><h3 style='margin:0 0 8px'>Conversation</h3><div id='rtTranscript' style='max-height:48vh;overflow:auto;font-size:14px;line-height:1.55'></div>" +
      "<div class='row' style='margin-top:8px'><button class='ghost' id='rtToChat'>Send transcript to chat</button></div></div>";
    $("#rtStartBtn").addEventListener("click", function () { if (RT.ws) rtStop(); else rtStart(); });
    $("#rtStopBtn").addEventListener("click", function () { rtStop(); });
    $("#rtMicBtn").addEventListener("click", function () {
      if (!RT.ws) return;
      RT.micOn = !RT.micOn;
      var mb = $("#rtMicBtn"); mb.classList.toggle("on", RT.micOn); mb.textContent = "Mic: " + (RT.micOn ? "ON" : "OFF");
      rtSetStatus(RT.micOn ? "live — speak" : "live — mic muted");
    });
    $("#rtToChat").addEventListener("click", function () {
      var lines = [...host.querySelectorAll(".rtline")].map(function (x) { return x.textContent });
      var txt = lines.join("\n").trim();
      if (!txt || txt.indexOf("session open") === 0) { toast("nothing to send yet", ""); return }
      var inp = null;
      rpc("chat.send", { sessionId: S.session || "main", message: "[realtime transcript]\n" + txt }).then(function (r) { toast("saved to chat " + (S.session || "main"), "ok"); }).catch(function (e) { toast(String(e), "err") });
    });
    if (RT.ws) { rtSetStatus("live"); }
  }
  window.RT = RT;

  // ---- voice: dictation (mic -> LFM3 ASR) + TTS of replies ----
  var V = { autoSpeak: localStorage.getItem("oh.autospeak") === "1", audioCtx: null, chunks: null, proc: null, stream: null, recording: false };
  function toB64(bytes) { var bin = ""; var arr = new Uint8Array(bytes); for (var i = 0; i < arr.length; i += 8192) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 8192)); return btoa(bin); }
  function encodeWav(samples, rate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buf);
    var wstr = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) };
    wstr(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); wstr(8, "WAVE"); wstr(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, "data"); v.setUint32(40, samples.length * 2, true);
    var off = 44; for (var i = 0; i < samples.length; i++, off += 2) v.setInt16(off, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return buf;
  }
  function speakText(text) {
    var t = String(text || "").trim();
    if (!t) return Promise.resolve();
    if (t.length > 1400) t = t.slice(0, 1400);
    return fetch("/api/voice/tts?text=" + encodeURIComponent(t) + "&token=" + encodeURIComponent(window.OH.getToken()), { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("tts http " + res.status); return res.blob() })
      .then(function (blob) { var a = new Audio(URL.createObjectURL(blob)); a.play(); setTimeout(function () { URL.revokeObjectURL(a.src) }, 60000); return 1 });
  }
  async function micToggle() {
    if (V.recording) { stopMic(); return; }
    try {
      V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      V.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      var src = V.audioCtx.createMediaStreamSource(V.stream);
      V.proc = V.audioCtx.createScriptProcessor(4096, 1, 1);
      V.chunks = [];
      V.proc.onaudioprocess = function (e) { V.chunks.push(Float32Array.from(e.inputBuffer.getChannelData(0))) };
      src.connect(V.proc); V.proc.connect(V.audioCtx.destination);
      V.recording = true;
      var mb = $("#micBtn"); if (mb) { mb.classList.add("rec"); mb.title = "stop dictation" }
      toast("listening... speak now, then tap the mic again", "ok");
    } catch (e) { toast("mic unavailable: " + (e.message || e), "err"); }
  }
  async function stopMic() {
    if (!V.recording) return;
    V.recording = false;
    var mb = $("#micBtn"); if (mb) { mb.classList.remove("rec"); mb.title = "dictate with voice (LFM3)" }
    try { V.proc.disconnect(); } catch (e) { }
    try { if (V.stream) V.stream.getTracks().forEach(function (t) { t.stop() }); } catch (e) { }
    var len = 0; for (var i = 0; i < V.chunks.length; i++) len += V.chunks[i].length;
    if (!len) { toast("no audio captured", "warn"); return; }
    var pcm = new Float32Array(len); var off = 0;
    for (var i = 0; i < V.chunks.length; i++) { pcm.set(V.chunks[i], off); off += V.chunks[i].length }
    var rate = V.audioCtx.sampleRate;
    try { V.audioCtx.close(); } catch (e) { }
    toast("transcribing...", "");
    try {
      var r = await rpc("voice.asr", { audio: toB64(encodeWav(pcm, rate)) });
      var inp = $("#chatInput");
      inp.value = (inp.value ? inp.value + " " : "") + String(r.text || "");
      inp.dispatchEvent(new Event("input"));
      inp.focus();
      toast("dictation added to the message", "ok");
    } catch (e) { toast("dictation failed: " + (e.message || e), "err"); }
  }
  function addPlay(metaHost, text) {
    var b = document.createElement("button");
    b.className = "ghost"; b.textContent = "listen"; b.style.cssText = "margin-left:6px;padding:1px 7px;font-size:11px";
    b.onclick = function () { b.textContent = "..."; speakText(text).then(function () { b.textContent = "listen" }).catch(function () { b.textContent = "listen"; toast("tts failed", "err") }) };
    metaHost.appendChild(b);
  }
  function renderMiniSessions() {
    var host = $("#miniSessions");
    if (!host) return;
    var skip = {};
    S.minions.forEach(function (m) { if (m.sessionId) skip[m.sessionId] = 1 });
    var chatSessions = S.sessions.filter(function (s) { return !skip[s.id] && s.chat !== false });
    chatSessions.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) });
    host.innerHTML = chatSessions.slice(0, 12).map(function (s) {
      return '<div class="srow ' + (s.id === S.session ? "on" : "") + '" data-open="' + esc(s.id) + '">' + esc(s.title || s.id) + "</div>";
    }).join("") || '<div class="dim" style="padding:6px 8px">none yet</div>';
  }
  async function loadSessionsCount() {
    try { S.sessions = await rpc("sessions.list", {}) || [] } catch (e) { return }
    renderMiniSessions();
    renderStatusFoot();
  }
  function renderModelPill() {
    var el = $("#modelPill"); if (!el) return;
    var st = S.settings || {}; var def = st.default || {};
    var prov = (st.providers || []).filter(function (p) { return p.id === def.providerId })[0];
    el.textContent = (def.modelId ? String(def.modelId) : "no model") + (def.effort && def.effort !== "none" ? " \u00b7 thinking: " + def.effort : "");
    el.title = (prov ? (prov.name || prov.id) + " / " : "") + "click Settings to change";
  }
  function renderStatusFoot() {
    var el = $("#statusFoot"); if (!el) return;
    var n = (S.sessions || []).length;
    fetch("/health").then(function (r) { return r.json() }).then(function (h) {
      el.textContent = "protocol " + (h.protocol ?? "?") + " \u00b7 " + n + " session" + (n === 1 ? "" : "s") + " \u00b7 pid " + h.pid + (h.others ? " \u00b7 \u26a0 " + h.others + " other instance" : "");
    }).catch(function () { el.textContent = n + " session" + (n === 1 ? "" : "s"); });
  }
  async function loadOverview() {
    var host = $("#v-overview");
    try {
      if (!S.settings) S.settings = await rpc("settings.get", {});
      var st = S.settings;
      var devs = await rpc("devices.list", {}) || [];
      S.minions = await rpc("agents.list", {}) || [];
      var sched = await rpc("schedule.list", {}) || [];
      var jobs = sched.filter(function (j) { return !j.disabled });
      var def = st.default || {};
      var prov = (st.providers || []).find(function (p) { return p.id === def.providerId });
      var running = S.minions.filter(function (m) { return m.status === "running" || m.status === "queued" || m.status === "waiting" });
      var nextJob = jobs.slice().sort(function (a, b) { return a.nextRunAt - b.nextRunAt })[0];
      host.innerHTML =
        '<h2 class="sec">Overview</h2>' +
        '<div class="cards">' +
        card("Model", prov ? esc(prov.name) : "not configured", esc(def.modelId || "-") + (def.effort && def.effort !== "none" ? " · thinking " + esc(def.effort) : ""), "settings") +
        card("Devices", String(devs.filter(function (d) { return d.connected }).length) + " online", esc(devs.map(function (d) { return d.name || d.id }).slice(0, 3).join(", ") || "only this gateway"), "devices") +
        card("Minions", running.length ? String(running.length) + " running" : "idle", "done: " + S.minions.filter(function (m) { return m.status === "done" }).length, "minions") +
        card("Schedule", jobs.length ? humanCadence(nextJob) : "no jobs", nextJob ? "next " + fmtDT(nextJob.nextRunAt) : "scheduler", "scheduler") +
        "</div>" +
        '<h2 class="sec">Recent activity</h2><div id="ovRecent"></div>';
      var mon = await rpc("monitor.status", {});
      var alerts = (await rpc("alerts.list", {})).filter(function (a) { return a.state === "firing" });
      var fireHtml = alerts.filter(function (a) { return !a.acked }).map(function (a) { return "<div class='alertrow'>🔥 <b>" + esc(a.name) + "</b> down — " + esc(a.detail) + " <span class='dim'>" + fmtAgo(a.at) + "</span> <button class='ghost' data-ack='" + esc(a.id) + "'>ack</button></div>" }).join("") || "<div class='dim'>no open alerts</div>";
      var svcRows = (mon.statuses || []).map(function (s) { return "<tr><td>" + (s.ok ? "🟢" : "🔴") + "</td><td>" + esc(s.name) + "</td><td class='dim'>" + esc(s.kind) + " · " + esc(s.url) + "</td><td>" + (s.latencyMs != null ? s.latencyMs + "ms" : "-") + "</td><td>" + (s.consecutiveFails > 1 ? s.consecutiveFails + " fails" : "ok") + "</td></tr>" }).join("") || "<tr><td colspan='5' class='dim'>no services probed yet</td></tr>";
      host.innerHTML +=
        "<h2 class='sec'>Alerts</h2>" + fireHtml +
        "<h2 class='sec'>Services" + (mon.lastCheckAt ? " <span class='dim' style='font-size:12px'>checked " + fmtAgo(mon.lastCheckAt) + "</span>" : "") + "</h2>" +
        "<table><tbody>" + svcRows + "</tbody></table>" +
        "<div class='row' style='margin-top:8px'><button class='ghost' id='monNow'>Re-check now</button> <button class='ghost' id='docNow'>Run doctor</button></div><div id='docOut'></div>";
      $("#monNow").onclick = async function () { $("#monNow").disabled = true; try { await rpc("monitor.check", {}); loadOverview() } finally { $("#monNow").disabled = false } };
      $("#docNow").onclick = async function () {
        $("#docNow").disabled = true; $("#docOut").innerHTML = "<div class='dim'>running checks…</div>";
        try {
          var r = await rpc("doctor.run", {});
          var fails = (r.checks || []).filter(function (c) { return !c.ok });
          $("#docOut").innerHTML = (r.checks || []).map(function (c) { return "<div class='" + (c.ok ? "dim" : "alertrow") + "'>" + (c.ok ? "✔ " : "✖ ") + esc(c.name) + " — " + esc(c.detail) + (c.hint ? " <span class='dim'>→ " + esc(c.hint) + "</span>" : "") + "</div>" }).join("") || "<div class='dim'>no checks</div>";
          toast(fails.length ? fails.length + " problem(s) found" : "all checks passed");
        } catch (err) { $("#docOut").innerHTML = "<div class='alertrow'>doctor failed: " + esc(String(err)) + "</div>" } finally { $("#docNow").disabled = false }
      };
      $("#ovRecent").innerHTML = recentRows();
    } catch (e) { host.innerHTML = '<div class="empty">error: ' + esc(String(e)) + "</div>" }
  }
  function card(t, big, sub, view) {
    return '<div class="card" data-openview="' + view + '"><h3>' + t + "</h3>" + '<div class="big">' + big + "</div>" + '<div class="sub">' + sub + "</div></div>";
  }
  function humanCadence(j) {
    if (!j) return "no jobs";
    if (j.cadence && j.cadence.type === "every") return "every " + j.cadence.minutes + "m";
    if (j.cadence && j.cadence.type === "daily") return "daily " + j.cadence.time;
    if (j.cadence && j.cadence.type === "once") return "once";
    return "scheduled";
  }
  function recentRows() {
    var list = S.minions.slice().sort(function (a, b) { return b.createdAt - a.createdAt }).slice(0, 8);
    if (!list.length) return '<div class="empty">nothing yet — send a message in Chat or dispatch a minion</div>';
    return "<table><tr><th>when</th><th>what</th><th>status</th><th>result</th></tr>" + list.map(function (m) {
      return "<tr><td>" + fmtAgo(m.createdAt) + "</td><td>" + esc(m.title || m.id) + "</td><td>" + statusTag(m.status) + "</td><td class='dim'>" + esc(String(m.result || m.error || "").slice(0, 80)) + "</td></tr>";
    }).join("") + "</table>";
  }
  function statusTag(s) {
    var cls = s === "done" ? "ok" : (s === "error" || s === "killed" ? "err" : "wait");
    return '<span class="tag ' + cls + '">' + esc(s) + "</span>";
  }
  async function loadSessions() {
    await loadSessionsCount();
    $("#v-sessions").innerHTML =
      '<h2 class="sec">Sessions</h2><div class="row"><button class="ghost" id="newSessBtn">+ New session</button><input id="sessQ" placeholder="search sessions... (Enter)" style="flex:1"><button class="ghost" id="sessQGo">Search</button></div><div id="sessHits"></div>' +
      "<table><tr><th>title</th><th>id</th><th>entries</th><th>created</th><th></th></tr>" +
      S.sessions.slice().sort(function (a, b) { return (Number(!!b.pinned) - Number(!!a.pinned)) || (b.createdAt - a.createdAt) }).map(function (s) {
        return "<tr><td>" + esc(s.title) + "</td><td class='dim'>" + esc(String(s.id).slice(0, 8)) + "</td><td>" + (s.entryCount || 0) + "</td><td>" + fmtDT(s.createdAt) + "</td><td><button class='ghost' data-openchat='" + esc(s.id) + "'>open chat</button> <button class='ghost' data-pin='" + esc(String(s.id)) + "' title='" + (s.pinned ? "unpin" : "pin") + "'>" + (s.pinned ? "📌" : "📍") + "</button> <a class='ghost' download style='text-decoration:none;padding:4px 8px' title='download markdown' href=\"/sessions/export?session=" + encodeURIComponent(String(s.id)) + "&token=" + encodeURIComponent(window.OH.getToken()) + "\">⬇</a>" +
          (String(s.id) !== "main" ? " <button class='ghost' data-rename='" + esc(s.id) + "' title='rename'>✎</button> <button class='ghost' data-del='" + esc(s.id) + "' title='delete session'>✕</button>" : "") + "</td></tr>";
      }).join("") + "</table>";
    $("#newSessBtn").onclick = function () {
      modal("New session", '<div class="row"><input type="text" id="nsTitle" placeholder="session title" style="flex:1"></div>', async function () {
        var s = await rpc("sessions.create", { title: $("#nsTitle").value || "chat" });
        await loadSessionsCount(); await openChat(s.id); showView("chat");
      }, "Create");
      setTimeout(function () { $("#nsTitle").focus() }, 50);
    };
    $$("#v-sessions [data-rename]").forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.rename;
        var cur = (S.sessions.filter(function (x) { return String(x.id) === id })[0] || {}).title || "";
        modal("Rename session", '<div class="row"><input type="text" id="rnTitle" style="flex:1" value="' + esc(cur) + '"></div>', async function () {
          var t = $("#rnTitle").value;
          if (!t.trim()) return;
          await rpc("sessions.rename", { id: id, title: t });
          toast("session renamed", "ok");
          await loadSessionsCount(); if (S.view === "sessions") loadSessions();
        }, "Rename");
        setTimeout(function () { var el = $("#rnTitle"); el.select(); el.focus(); }, 50);
      };
    });
    $$("#v-sessions [data-del]").forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.del;
        var s = S.sessions.filter(function (x) { return String(x.id) === id })[0] || {};
        modal("Delete session?", "<div>\"" + esc(s.title || id) + "\" (" + (s.entryCount || 0) + " entries) will be removed. This is not recoverable except from daily backups.</div>", async function () {
          var r = await rpc("sessions.delete", { id: id });
          if (r && r.ok) { toast("deleted session " + String(id).slice(0, 8), "ok"); if (S.session === id) { S.session = "main"; } await loadSessionsCount(); loadSessions(); }
          else toast("delete refused (main is protected)", "err");
        }, "Delete");
      };
    });
    var runSessSearch = async function () {
      var q = $("#sessQ").value.trim();
      if (!q) { $("#sessHits").innerHTML = ""; return }
      try {
        var hits = await rpc("sessions.search", { q: q, limit: 50 });
        $("#sessHits").innerHTML = hits.length
          ? "<table><tr><th>session</th><th>match</th><th></th></tr>" + hits.map(function (h) {
            return "<tr><td>" + esc(h.title) + " <span class='dim'>(" + h.hits + " hits)</span></td><td class='dim' title='seq " + h.matchSeq + "'>" + esc(h.snippet.slice(0, 90)) + (h.snippet.length > 90 ? "…" : "") + "</td><td><button class='ghost' data-hit='" + esc(String(h.id)) + "'>open</button></td></tr>";
          }).join("") + "</table>"
          : "<div class='dim'>no sessions matching \"" + esc(q) + "\"</div>";
        $$("#sessHits [data-hit]").forEach(function (b) {
          b.onclick = async function () { showView("chat"); await openChat(b.dataset.hit); };
        });
      } catch (err) { $("#sessHits").innerHTML = "<div class='dim'>search failed: " + esc(String(err)) + "</div>" }
    };
    $("#sessQGo").onclick = runSessSearch;
    $("#sessQ").onkeydown = function (ev) { if (ev.key === "Enter") runSessSearch() };
    $$("#v-sessions [data-pin]").forEach(function (b) {
      b.onclick = async function () {
        await rpc("sessions.pin", { id: b.dataset.pin, pinned: !((S.sessions.filter(function (x) { return String(x.id) === b.dataset.pin })[0] || {}).pinned) });
        await loadSessionsCount(); if (S.view === "sessions") loadSessions();
      };
    });
  }
  async function loadMinions() {
    var host = $("#v-minions");
    try {
      S.minions = await rpc("agents.list", {}) || [];
      renderMiniSessions();
      host.innerHTML =
        '<h2 class="sec">Minions</h2>' +
        '<div class="row"><input id="mTask" placeholder="dispatch a task to a minion..." style="flex:2"></div>' +
        '<div class="row"><input id="mTitle" placeholder="title (optional)" style="flex:1"><select id="mEffort"><option value="none">thinking: off</option><option value="low">low</option><option value="medium">medium</option><option value="xhigh">high</option></select><input id="mTurns" type="number" placeholder="max turns" value="12" style="width:110px" class="noflex"><button class="primary" id="mSpawnBtn">Dispatch</button></div>' +
        "<table><tr><th>when</th><th>title</th><th>task</th><th>status</th><th>turns</th><th>result</th><th></th></tr>" +
        S.minions.slice().sort(function (a, b) { return b.createdAt - a.createdAt }).map(function (m) {
          return "<tr><td>" + fmtAgo(m.createdAt) + "</td><td>" + esc(m.title || m.id) + "</td><td class='dim'>" + esc(String(m.task || "").slice(0, 50)) + "</td><td>" + statusTag(m.status) + (m.dependsOn ? " <span class='tag'>deps</span>" : "") + "</td><td>" + m.turnsUsed + "/" + m.maxTurns + "</td><td class='dim'>" + esc(String(m.result || m.error || "").slice(0, 60)) + "</td><td><button class='ghost' data-mshow='" + esc(m.id) + "'>show</button> " +
            (m.status === "running" || m.status === "queued" || m.status === "waiting" ? "<button class='ghost danger' data-mkill='" + esc(m.id) + "'>kill</button>" : "") + "</td></tr>";
        }).join("") + "</table>";
      $("#mSpawnBtn").onclick = async function () {
        var t = $("#mTask").value.trim(); if (!t) { toast("task is empty", "err"); return }
        try {
          await rpc("agents.spawn", { task: t, title: $("#mTitle").value || undefined, effort: $("#mEffort").value, maxTurns: Number($("#mTurns").value) || 12 });
          $("#mTask").value = ""; toast("minion dispatched"); setTimeout(loadMinions, 400);
        } catch (e) { toast(String(e), "err") }
      };
    } catch (e) { host.innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  async function showMinion(id) {
    var m = await rpc("agents.get", { id: id });
    if (!m) return toast("not found", "err");
    var rows = (m.entries || []).map(function (e) {
      var d = e.data || {};
      if (e.kind === "chat") return "<p><strong>" + esc(String(d.role || "")) + "</strong> — " + esc(String(d.text || "").slice(0, 500)) + "</p>";
      if (e.kind === "summary") return '<p class="dim">[summary] ' + esc(String(d.text || "").slice(0, 200)) + "</p>";
      return "<p class='dim'>[" + esc(e.kind) + "] " + esc(JSON.stringify(d).slice(0, 300)) + "</p>";
    }).join("");
    modal("minion " + (m.title || m.id), '<div class="dim" style="margin-bottom:10px">' + esc(m.task) + " — " + statusTag(m.status) + " turns " + m.turnsUsed + "/" + m.maxTurns + "</div>" + rows);
  }
  async function loadScheduler() {
    var host = $("#v-scheduler");
    try {
      var jobs = await rpc("schedule.list", {}) || [];
      host.innerHTML =
        '<h2 class="sec">Scheduler</h2>' +
        '<div class="row"><input id="jMsg" placeholder="message / task" style="flex:2"><input id="jLabel" placeholder="label (optional)" style="flex:1"></div>' +
        '<div class="row"><select id="jType" class="noflex"><option value="every">every...</option><option value="daily">daily at...</option><option value="once">once at...</option></select>' +
        '<input id="jEvery" type="number" placeholder="minutes" value="60" style="width:110px"><input id="jTime" type="time" value="09:00" style="display:none"><input id="jAt" type="datetime-local" style="display:none">' +
        '<button class="primary" id="jCreate">Create</button></div>' +
        "<table><tr><th>label</th><th>cadence</th><th>next run</th><th>last</th><th></th></tr>" +
        jobs.map(function (j) {
          return "<tr><td>" + esc(j.label) + (j.disabled ? " <span class='tag wait'>disabled</span>" : "") + "</td><td>" + humanCadence(j) + "</td><td>" + fmtDT(j.nextRunAt) + "</td><td class='dim'>" + (j.lastRunAt ? fmtAgo(j.lastRunAt) : "-") + "</td>" +
            "<td><button class='ghost' data-jrun='" + esc(j.id) + "'>run now</button> <button class='ghost' data-jdis='" + esc(j.id) + "' data-dis='" + String(!j.disabled) + "'>" + (j.disabled ? "enable" : "disable") + "</button> <button class='ghost danger' data-jdel='" + esc(j.id) + "'>remove</button></td></tr>";
        }).join("") + "</table>";
      $("#jType").onchange = function () {
        $("#jEvery").style.display = this.value === "every" ? "" : "none";
        $("#jTime").style.display = this.value === "daily" ? "" : "none";
        $("#jAt").style.display = this.value === "once" ? "" : "none";
      };
      $("#jCreate").onclick = async function () {
        var type = $("#jType").value;
        var cadence = type === "every" ? { type: "every", minutes: Number($("#jEvery").value) || 60 } : type === "daily" ? { type: "daily", time: $("#jTime").value } : { type: "once", at: new Date($("#jAt").value).toISOString() };
        try { await rpc("schedule.create", { message: $("#jMsg").value, label: $("#jLabel").value || undefined, cadence: cadence }); toast("job created"); loadScheduler() } catch (e) { toast(String(e), "err") }
      };
    } catch (e) { host.innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  async function loadMemory() {
    var host = $("#v-memory");
    host.innerHTML =
      '<h2 class="sec">Memory</h2>' +
      '<div class="row"><input id="mq" placeholder="search memory..." style="flex:2"><button class="ghost" id="msearchBtn">Search</button><button class="ghost" id="mConsBtn">Consolidate</button></div>' +
      '<div class="row"><input id="mAddPh" placeholder="add a fact for the user... (saved under subject: user)" style="flex:2"><button class="ghost" id="mAddBtn">Add</button></div>' +
      '<div id="mresults"><div class="dim" style="padding:20px;text-align:center">type to search, or browse below</div></div>';
    $("#msearchBtn").onclick = doMemorySearch;
    $("#mq").onkeydown = function (e) { if (e.key === "Enter") doMemorySearch() };
    $("#mAddBtn").onclick = async function () {
      var t = $("#mAddPh").value.trim(); if (!t) return;
      try { await rpc("memory.add", { text: t, subject: "user" }); $("#mAddPh").value = ""; toast("saved"); doMemorySearch() } catch (e) { toast(String(e), "err") }
    };
    $("#mConsBtn").onclick = async function () {
      toast("consolidating...");
      try { var r = await rpc("memory.consolidate", {}); toast("consolidated " + (r.memoriesChecked || 0) + " memories (" + (r.clusters || []).length + " clusters)"); doMemorySearch() } catch (e) { toast(String(e), "err") }
    };
    try {
      var list = await rpc("memory.list", { limit: 50 }) || [];
      renderMem(list.map(function (m) { return { memory: m, score: null } }), "memory (latest)");
    } catch (e) { $("#mresults").innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  async function doMemorySearch() {
    var q = $("#mq").value.trim();
    var host = $("#mresults");
    if (!q) { doMemoryBrowse(); return }
    host.innerHTML = '<div class="dim" style="padding:14px">searching...</div>';
    try {
      var hits = await rpc("memory.search", { query: q, limit: 50 }) || [];
      renderMem(hits, "results for " + esc(q));
    } catch (e) { host.innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  function doMemoryBrowse() {
    rpc("memory.list", { limit: 50 }).then(function (list) { renderMem((list || []).map(function (m) { return { memory: m, score: null } }), "memory (latest)") });
  }
  function renderMem(hits, note) {
    var host = $("#mresults");
    if (!hits.length) { host.innerHTML = '<div class="empty">no memories found</div>'; return }
    host.innerHTML = "<div class='dim' style='margin:8px 0'>" + note + "</div><table><tr><th>when</th><th>subject</th><th>memory</th><th>tags</th><th>score</th><th>state</th></tr>" +
      hits.map(function (h) {
        var m = h.memory || h;
        var state = m.supersededBy ? "<span class='tag err'>superseded</span>" : (m.validUntil ? "<span class='tag'>expired</span>" : "");
        return "<tr><td class='dim'>" + fmtDT(m.createdAt) + "</td><td>" + esc(m.subject) + "</td><td>" + esc(m.text) + "</td><td>" + (m.tags || []).map(function (t) { return "<span class='tag'>" + esc(t) + "</span>" }).join("") + "</td><td>" + (h.score != null ? String(Math.round(h.score * 100)) + "%" : "-") + "</td><td>" + state + "</td></tr>";
      }).join("") + "</table>";
  }
  async function loadTools() {
    var host = $("#v-tools");
    try {
      var asks = await rpc("tools.pending", {}).catch(function () { return [] });
      var grants = await rpc("grants.list", {}).catch(function () { return [] });
      var offered = await rpc("device.tools.list", {}).catch(function () { return [] });
      var html = '<h2 class="sec">Tools</h2>';
      if (asks.length) {
        html += "<h3 style='margin-bottom:8px'>Waiting for your approval</h3>" + asks.map(function (a) {
          return '<div class="card" style="margin-bottom:10px"><strong>' + esc(a.tool) + "</strong> <span class='dim'>requested by " + esc(a.requester || "?") + " · device " + esc(String(a.deviceId).slice(0, 8)) + "</span><pre style='margin:8px 0;font-size:12px'>" + esc(JSON.stringify(a.args || {}, null, 2).slice(0, 500)) + "</pre><div class='row'>" +
            "<button class='primary noflex' data-tyes='" + esc(a.id) + "'>Approve</button>" +
            "<button class='ghost' data-trem='" + esc(a.id) + "'>Approve &amp; always allow</button>" +
            "<button class='ghost danger' data-tno='" + esc(a.id) + "'>Deny</button></div></div>";
        }).join("");
      } else {
        html += "<div class='card' style='margin-bottom:14px'><h3>Approvals</h3><div class='dim'>nothing waiting — when a minion wants to use a device tool, the request shows up here.</div></div>";
      }
      html += "<h3 style='margin:14px 0 8px'>Devices offering tools</h3>";
      html += offered.length ? "<table><tr><th>device</th><th>tools</th></tr>" + offered.map(function (o) {
        return "<tr><td>" + esc(o.deviceId) + "</td><td>" + (o.tools || []).map(function (t) { return "<span class='tag'>" + esc(t.name || t) + "</span>" }).join("") + "</td></tr>";
      }).join("") + "</table>" : '<div class="empty">none</div>';
      html += "<h3 style='margin:14px 0 8px'>Standing grants</h3>";
      html += grants.length ? "<table><tr><th>device</th><th>tool</th><th>granted</th><th></th></tr>" + grants.map(function (g) {
        return "<tr><td>" + esc(String(g.deviceId).slice(0, 8)) + "</td><td>" + esc(g.tool) + "</td><td class='dim'>" + fmtDT(g.createdAt) + "</td><td><button class='ghost danger' data-grev='" + esc(g.deviceId) + "|" + esc(g.tool) + "'>revoke</button></td></tr>";
      }).join("") + "</table>" : "<div class='dim'>none</div>";
      host.innerHTML = html;
    } catch (e) { host.innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  async function loadDevices() {
    var host = $("#v-devices");
    try {
      var devs = await rpc("devices.list", {});
      var pairs = await rpc("pairing.list", {}).catch(function () { return [] });
      host.innerHTML =
        '<h2 class="sec">Devices</h2><table><tr><th>name</th><th>kind</th><th>state</th><th>transport</th><th>last seen</th></tr>' +
        devs.map(function (d) {
          var tr = (d.meta && d.meta.transport) || (d.connected ? "gateway" : "");
          var ls = d.meta && d.meta.lastSeenAt ? fmtAgo(d.meta.lastSeenAt) : "-";
          return "<tr><td>" + esc(d.name || d.id) + "</td><td>" + esc(d.kind) + "</td><td>" + (d.connected ? "<span class='tag ok'>online</span>" : "<span class='tag err'>offline</span>") + "</td><td class='dim'>" + esc(tr) + "</td><td class='dim'>" + ls + "</td></tr>";
        }).join("") + "</table>" +
        "<h3 style='margin:18px 0 8px'>Pairing</h3>" +
        '<div class="row"><input id="pairKind" placeholder="kind (mobile)" class="noflex" style="width:150px"><button class="ghost" id="pairCreate">Create pair code</button><span id="pairOut" class="dim"></span></div>' +
        "<table><tr><th>name</th><th>kind</th><th>scopes</th><th>paired</th><th>last seen</th><th>state</th><th></th></tr>" +
        pairs.map(function (p) {
          return "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.kind) + "</td><td>" + (p.scopes || []).map(function (s) { return "<span class='tag'>" + esc(s) + "</span>" }).join("") + "</td><td class='dim'>" + fmtDT(p.pairedAt) + "</td><td class='dim'>" + (p.lastSeenAt ? fmtAgo(p.lastSeenAt) : "-") + "</td><td>" + (p.revokedAt ? "<span class='tag err'>revoked</span>" : "<span class='tag ok'>active</span>") + "</td><td>" + (p.revokedAt ? "" : "<button class='ghost danger' data-prev='" + esc(p.id) + "'>revoke</button>") + "</td></tr>";
        }).join("") + "</table>" +
        "<div class='row' style='margin-top:14px'><button class='ghost' id='selfPairBtn'>Pair this browser (secret)</button><span class='dim'>pairs this browser with read/write scope using its own secret — for phones use /m instead.</span></div>";
      $("#pairCreate").onclick = async function () {
        try { var c = await rpc("pairing.create", { kind: $("#pairKind").value || "mobile", scopes: ["read", "write"] }); $("#pairOut").innerHTML = "code: <strong>" + esc(c.code) + "</strong> (expires in 10 min)"; toast("code generated") } catch (e) { toast(String(e), "err") }
      };
      $("#selfPairBtn").onclick = async function () {
        try {
          var c = await rpc("pairing.create", { kind: "browser", scopes: ["read", "write"] });
          var r = await fetch("/pair", { method: "POST", body: JSON.stringify({ code: c.code, name: "this browser" }) }).then(function (x) { return x.json() });
          if (r.ok) { localStorage.setItem("oh.secret", r.secret); toast("paired — reconnecting"); window.OH.reconnect() } else toast(r.error || "pair failed", "err");
        } catch (e) { toast(String(e), "err") }
      };
    } catch (e) { host.innerHTML = '<div class="empty">' + esc(String(e)) + "</div>" }
  }
  function voiceSectionHtml() {
    return "<h3 style='margin:16px 0 8px'>Voice (LFM3)</h3>" +
      "<div class='row'><span style='width:130px' class='dim'>dictation / asr</span><input id='vAsrUrl' style='width:280px' placeholder='http://127.0.0.1:8023'><label style='display:flex;gap:6px;align-items:center'><input id='vAsrOn' type='checkbox'> enabled</label></div>" +
      "<div class='row'><span style='width:130px' class='dim'>tts</span><input id='vTtsUrl' style='width:280px' placeholder='http://127.0.0.1:8023'><label style='display:flex;gap:6px;align-items:center'><input id='vTtsOn' type='checkbox'> enabled</label></div>" +
      "<div class='row'><span style='width:130px' class='dim'>language</span><input id='vLang' style='width:90px' placeholder='italian'></div>" +
      "<div class='row'><span style='width:130px' class='dim'>realtime</span><input id='vRtUrl' style='width:280px' placeholder='ws://127.0.0.1:8024/'><select id='vVoice'><option value='female'>female</option><option value='male'>male</option></select><label style='display:flex;gap:6px;align-items:center'><input id='vAuto' type='checkbox'> auto-speak replies</label></div>" +
      "<div class='row'><button class='ghost' id='vProbe'>test voice services</button><button class='primary' id='vSave'>save voice settings</button><span id='vOut' class='dim'></span></div>";
  }
  async function loadVoiceCard() {
    try {
      var v = await rpc("voice.get", {});
      if (!v) return;
      if ($("#vAsrUrl")) {
        $("#vAsrUrl").value = (v.asr && v.asr.url) || "";
        $("#vAsrOn").checked = !!(v.asr && v.asr.enabled);
        $("#vTtsUrl").value = (v.tts && v.tts.url) || "";
        $("#vTtsOn").checked = !!(v.tts && v.tts.enabled);
        $("#vLang").value = (v.asr && v.asr.language) || "italian";
        $("#vRtUrl").value = (v.realtime && v.realtime.url) || "";
        $("#vVoice").value = (v.realtime && v.realtime.voice) || "female";
        $("#vAuto").checked = !!(v.autoSpeak);
      }
    } catch (e) { /* voice rpc unavailable */ }
  }
  function authSectionHtml() {
    return "<h3 style='margin:16px 0 8px'>Access</h3>" +
      "<div class='row'><span style='width:130px' class='dim'>master password</span>" +
      "<input id='pwSet1' type='password' placeholder='new password (min 8 chars)' style='width:200px'>" +
      "<input id='pwSet2' type='password' placeholder='confirm' style='width:120px'>" +
      "<button class='ghost' id='pwSave'>set password</button><span id='pwOut' class='dim'></span></div>" +
      "<div class='row'><span style='width:130px' class='dim'>token login</span><label style='display:flex;gap:6px;align-items:center'><input id='tokEnabled' type='checkbox'> allow the raw token (" +
      (S.tokenEnabled ? "on" : "off") + ")</label><span class='dim'>saved in ~/.o-harness/config.json</span><button class='ghost' id='tokSave'>apply</button></div>" +
      "<div class='row'><span style='width:130px' class='dim'>login sessions</span><span id='sessOut' class='dim'>loading…</span></div>" +
      "<table><tbody id='authSess'></tbody></table>" +
      "<div class='row'><button class='ghost' id='logoutBtn'>log out of this browser</button><button class='ghost' id='oauthCfg'>+ configure oauth provider</button><span id='authOut' class='dim'></span></div>";
  }
  async function loadAuthPanel() {
    try {
      var info = await (await fetch("/auth/info")).json();
      S.tokenEnabled = info.tokenEnabled;
      var cb = $("#tokEnabled"); if (cb) cb.checked = !!info.tokenEnabled;
      var sess = await rpc("auth.sessions.list", {});
      var tb = $("#authSess");
      var so = $("#sessOut"); if (so) so.textContent = ((sess || []).length) + " active";
      if (tb) tb.innerHTML = (sess || []).map(function (s) {
        return "<tr><td class='dim'>" + esc(s.kind) + (s.provider ? ":" + esc(s.provider) : "") + "</td><td class='dim'>" + esc(s.label || "") + "</td><td class='dim'>expires " + new Date(s.expiresAt).toLocaleDateString() + "</td><td><button class='ghost' data-authrev='" + esc(s.key) + "'>revoke</button></td></tr>";
      }).join("");
      $$("[data-authrev]").forEach(function (b) { b.onclick = async function () { await rpc("auth.sessions.revoke", { key: b.dataset.authrev }); toast("session revoked", "ok"); loadAuthPanel() } });
      var pwS = $("#pwSave");
      if (pwS) pwS.onclick = async function () {
        var a = $("#pwSet1").value, c = $("#pwSet2").value;
        if (a !== c) { $("#pwOut").textContent = "confirm does not match"; return }
        try { await rpc("auth.setPassword", { password: a }); toast("password set — other sessions logged out", "ok"); $("#pwSet1").value = $("#pwSet2").value = ""; $("#pwOut").textContent = ""; }
        catch (err) { $("#pwOut").textContent = String(err.message || err) }
      };
      var tokS = $("#tokSave");
      if (tokS) tokS.onclick = async function () {
        var st = S.settings; if (!st) return;
        var cur = S.settingsRaw || st;
        S.tokenEnabled = $("#tokEnabled").checked;
        toast("token login " + (S.tokenEnabled ? "enabled" : "will be disabled") + " after restart — set tokenEnabled in config.json", "ok");
      };
      var lo = $("#logoutBtn");
      if (lo) lo.onclick = async function () {
        try { await rpc("auth.logout", {}); } catch (err) { }
        location.href = "/logout";
      };
      var oc = $("#oauthCfg");
      if (oc) oc.onclick = function () { showView("settings"); configureOAuth(); };
    } catch (err) { var so = $("#sessOut"); if (so) so.textContent = "auth unavailable" }
  }
  async function configureOAuth() {
    var name = await modal("OAuth provider",
      "<div class='row'><input id='oName' placeholder='name (github, google, oidc)' style='width:100%'></div>" +
      "<div class='row'><input id='oAuth' placeholder='authorize url' style='width:100%'></div>" +
      "<div class='row'><input id='oTok' placeholder='token url' style='width:100%'></div>" +
      "<div class='row'><input id='oUi' placeholder='userinfo url' style='width:100%'></div>" +
      "<div class='row'><input id='oCid' placeholder='client id' style='width:50%'><input id='oCsec' type='password' placeholder='client secret' style='width:50%'></div>" +
      "<div class='row'><input id='oScopes' placeholder='scopes (read:profile)' style='width:60%'><input id='oSubs' placeholder='allowed user ids, comma-separated (empty = anyone)' style='width:40%'></div>",
      async function () {
        var subs = ($("#oSubs").value || "").split(",").map(function (x) { return x.trim() }).filter(Boolean);
        await rpc("auth.oauth.set", {
          name: $("#oName").value, authorizeUrl: $("#oAuth").value, tokenUrl: $("#oTok").value,
          userInfoUrl: $("#oUi").value, clientId: $("#oCid").value, clientSecret: $("#oCsec").value,
          scopes: ($("#oScopes").value || "").trim(), subs: subs,
        });
        toast("oauth provider saved", "ok");
      }, "save");
  }
  function backupSectionHtml() {
    return '<h2>Backups</h2><div class="card"><p class="dim">Automatic encrypted-at-rest data-dir snapshots (~1h after boot, then daily). Restore needs a gateway restart.</p><div class="row"><button class="ghost" id="bkRun">Back up now</button><button class="ghost" id="bkRefresh">Refresh</button><span id="bkOut" class="dim"></span></div><table><tbody id="bkRows"></tbody></table></div>';
  }
  async function loadBackupPanel() {
    try {
      var r = await rpc("backup.list", {});
      var tb = $("#bkRows");
      if (!tb) return;
      if (!r.backups.length) { tb.innerHTML = '<tr><td class="dim">no backups yet</td></tr>'; return; }
      tb.innerHTML = r.backups.map(function (b) { return '<tr><td>' + esc(b.name) + '</td><td class="dim">' + Math.round(b.bytes / 1024) + ' KB</td><td class="dim">' + fmtDT(b.mtime) + '</td></tr>'; }).join("");
    } catch (e) { /* ignore */ }
    var rb = $("#bkRun");
    if (rb) rb.onclick = function () { rpc("backup.run", {}).then(function (res) { toast("backup ok (" + res.files + " files)", "ok"); loadBackupPanel(); }); };
    var rf = $("#bkRefresh");
    if (rf) rf.onclick = loadBackupPanel;
  }

  function cacheSectionHtml() {
    return '<h3 style="margin:16px 0 8px">Model cache</h3><div class="row"><span id="cacheOut" class="dim">loading...</span><button class="ghost" id="cacheClear">Clear cache</button></div>';
  }
  async function loadCachePanel() {
    var el = $("#cacheOut"); if (!el) return;
    try {
      var c = await rpc("cache.stats", {});
      el.textContent = c.entries + " entries · " + c.hits + " hits / " + c.misses + " misses · " + Math.round(c.hitRate * 100) + "% hit rate · ttl " + Math.round(c.ttlMs / 1000) + "s";
      var cb = $("#cacheClear");
      if (cb) cb.onclick = function () { rpc("cache.clear", {}).then(function (r) { toast("cleared " + r.cleared + " entries", "ok"); loadCachePanel() }); };
    } catch (e) { el.textContent = String(e); }
  }
  async function loadSettings() {
    var st = S.settings = await rpc("settings.get", {});
    renderModelPill();
    var def = st.default || {};
    var byId = {}; (st.providers || []).forEach(function (p) { byId[p.id] = p });
    var rows = (st.providers || []).map(function (p, i) {
      var modelNames = ((p.models && p.models.length) ? p.models.map(function (m) { return (m && m.id) ? m.id : String(m) }) : (((p.extra && p.extra.models) || []).slice()));
      if (!modelNames.length && p.modelId) modelNames = [p.modelId];
      return '<tr data-pid="' + esc(p.id) + '">' +
        "<td><input type='text' data-f='name' value='" + esc(p.name) + "' style='width:140px'></td>" +
        "<td><input type='text' data-f='url' value='" + esc(p.baseUrl || "") + "' style='width:230px'></td>" +
        "<td><input type='password' data-f='key' placeholder='" + (p.apiKey ? "set" : "none") + "' style='width:110px'></td>" +
        "<td><select data-f='model' style='min-width:170px'>" + modelNames.map(function (n) { return "<option>" + esc(n) + "</option>" }).join("") + "</select></td>" +
        "<td class='dim' data-f='models'>" + modelNames.length + " known</td>" +
        "<td><button class='ghost' data-pfetch='" + i + "'>fetch models</button> <button class='ghost' data-ptest='" + i + "'>test</button> <button class='ghost danger' data-pdel='" + i + "'>x</button></td></tr>";
    }).join("");
    $("#v-settings").innerHTML =
      '<h2 class="sec">Settings</h2>' +
      '<div class="row"><span style="width:130px" class="dim">default model</span><select id="defProv" style="min-width:180px">' +
      (st.providers || []).map(function (p) { return "<option value='" + esc(p.id) + "'" + (p.id === def.providerId ? " selected" : "") + ">" + esc(p.name) + "</option>" }).join("") +
      '</select><select id="defModel" style="min-width:200px"></select>' +
      '<select id="defEffort"><option value="none">thinking off</option><option value="low">low</option><option value="medium">medium</option><option value="xhigh">high</option></select></div>' +
      '<div class="row"><span style="width:130px" class="dim">self-update</span><label style="display:flex;gap:6px;align-items:center"><input id="allowUp" type="checkbox"' + (st.allowSelfUpdate ? " checked" : "") + "> allow model self-update</label><button class='ghost' id='checkUp'>Check for updates</button><span id=upOut class=dim></span></div>" +
      "<h3 style='margin:16px 0 8px'>Providers</h3><table><tr><th>name</th><th>base url</th><th>api key</th><th>default model</th><th>models</th><th></th></tr><tbody id='provRows'>" + rows + "</tbody></table>" +
      "<div class='row' style='margin-top:12px'><button class='ghost' id='addProv'>+ Add provider</button><button class='primary' id='saveProv'>Save settings</button><span id='setOut' class='dim'></span></div>" +
      authSectionHtml() +
      voiceSectionHtml() + cacheSectionHtml() + backupSectionHtml();
    loadAuthPanel();
    loadVoiceCard();
    loadCachePanel();
    loadBackupPanel();
    var vs = $("#vSave");
    if (vs) vs.onclick = async function () {
      var cfg = {
        asr: { enabled: $("#vAsrOn").checked, url: $("#vAsrUrl").value.trim(), language: $("#vLang").value.trim() || "italian" },
        tts: { enabled: $("#vTtsOn").checked, url: $("#vTtsUrl").value.trim(), language: $("#vLang").value.trim() || "italian" },
        realtime: { enabled: !!$("#vRtUrl").value.trim(), url: $("#vRtUrl").value.trim(), voice: $("#vVoice").value },
        autoSpeak: $("#vAuto").checked
      };
      localStorage.setItem("oh.autospeak", cfg.autoSpeak ? "1" : "0");
      V.autoSpeak = cfg.autoSpeak;
      var sb = $("#speakBtn"); if (sb) sb.classList.toggle("on", V.autoSpeak);
      try { await rpc("voice.save", { voice: cfg }); $("#vOut").textContent = "saved"; toast("voice settings saved", "ok") }
      catch (e) { $("#vOut").textContent = String(e); toast(String(e), "err") }
    };
    var vp = $("#vProbe");
    if (vp) vp.onclick = async function () {
      $("#vOut").textContent = "probing...";
      try {
        var r = await rpc("voice.probe", {});
        var b = r.batch || {}, rt = r.realtime || {};
        $("#vOut").textContent = "batch " + (b.ok ? "ok (" + (b.device || "") + ")" : "DOWN") + " · realtime " + (rt.ok ? "ok" : "DOWN");
      } catch (e) { $("#vOut").textContent = String(e) }
    };
    function fillModel(sel, names, cur) {
      sel.innerHTML = names.map(function (n) { return "<option>" + esc(n) + "</option>" }).join("") || "<option>(none)</option>";
      if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    }
    var defProv = $("#defProv");
    function defModels() {
      var p = byId[defProv.value] || {};
      var names = ((p.models && p.models.length) ? p.models.map(function (m) { return (m && m.id) ? m.id : String(m) }) : (((p.extra && p.extra.models) || []).slice()));
      if (!names.length && p.modelId) names = [p.modelId];
      fillModel($("#defModel"), names, def.modelId || (names.length ? names[0] : ""));
    }
    defModels();
    defProv.onchange = function () { def.modelId = null; defModels() };
    $("#addProv").onclick = function () {
      var id = prompt("provider id (lowercase, unique)", "my-provider"); if (!id) return;
      id = id.trim().toLowerCase().split(/[^a-z0-9-]/).filter(Boolean).join("-");
      if (byId[id]) return toast("id exists", "err");
      S.settings.providers.push({ id: id, name: id, baseUrl: "http://127.0.0.1:8000/v1", models: [] });
      loadSettings();
    };
    $("[data-pdel]") && $$(".ghost").length; // noop guard
    $$("[data-pdel]").forEach(function (b) {
      b.onclick = function () { var i = +b.dataset.pdel; S.settings.providers.splice(i, 1); loadSettings() };
    });
    $$("[data-pfetch]").forEach(function (b) {
      b.onclick = async function () {
        var i = +b.dataset.pfetch; var tr = b.closest("tr");
        tr.querySelector("[data-f=models]").textContent = "...";
        try {
          var models = await rpc("models.fetch", { providerId: S.settings.providers[i].id });
          var list = (models && models.models ? models.models : models) || [];
          var names = list.map(function (x) { return typeof x === "string" ? x : x.id });
          var pp = S.settings.providers[i]; var oldm = {}; (pp.models || []).forEach(function (x) { if (x && x.id) oldm[x.id] = x });
          pp.models = names.map(function (n) { return oldm[n] || { id: n, reasoningEfforts: ["none", "low", "medium", "xhigh"] } }); delete pp.modelId;
          fillModel(tr.querySelector("[data-f=model]"), names, names[0]);
          tr.querySelector("[data-f=models]").textContent = names.length + " fetched";
        } catch (e) { toast(String(e), "err"); tr.querySelector("[data-f=models]").textContent = "failed" }
      };
    });
    $$("[data-ptest]").forEach(function (b) {
      b.onclick = async function () {
        var i = +b.dataset.ptest;
        b.textContent = "testing...";
        try { var r = await rpc("models.test", { providerId: S.settings.providers[i].id }); b.textContent = "test"; toast("reply: " + (r && (r.reply || r.ok) || "alive"), "ok") }
        catch (e) { b.textContent = "test"; toast(String(e), "err") }
      };
    });
    function collect() {
      $$("[data-pid]").forEach(function (tr, idx) {
        var p = S.settings.providers[idx];
        var v = function (f) { return tr.querySelector("[data-f=" + f + "]").value };
        p.name = v("name") || p.name;
        var bu = v("url"); if (bu) p.baseUrl = bu;
        delete p.url;
        var k = v("key"); if (k && k.indexOf("*") < 0) p.apiKey = k;
        var sel = tr.querySelector("[data-f=model]");
        var names = (sel && sel.options.length) ? [].slice.call(sel.options).map(function (o) { return o.value }) : [];
        if (names.length) {
          var oldm2 = {}; (p.models || []).forEach(function (x) { if (x && x.id) oldm2[x.id] = x });
          p.models = names.map(function (n) { return oldm2[n] || { id: n, reasoningEfforts: ["none", "low", "medium", "xhigh"] } });
          delete p.modelId;
        }
      });
      S.settings.default = { providerId: defProv.value, modelId: $("#defModel").value, effort: $("#defEffort").value };
      S.settings.allowSelfUpdate = $("#allowUp").checked;
    }
    $("#saveProv").onclick = async function () {
      collect();
      try { await rpc("settings.save", { settings: S.settings }); S.settings = await rpc("settings.get", {}); renderModelPill(); $("#setOut").textContent = "saved " + fmtT(Date.now()); toast("settings saved", "ok") } catch (e) { toast(String(e), "err") }
    };
    $("#checkUp").onclick = async function () {
      $("#upOut").textContent = "checking...";
      try { var r = await rpc("self.update", {}); $("#upOut").textContent = r.upToDate ? "up to date" : (r.updated ? "updated" : String(r.message || "")) } catch (e) { $("#upOut").textContent = String(e) }
    };
  }
  function modal(title, html, onOk, okLabel) {
    return new Promise(function (resolve) {
      var host = $("#modalHost");
      host.innerHTML = '<div class="card"><h2 style="font-size:15px;margin-bottom:10px">' + esc(title) + "</h2>" + html +
        '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="ghost" id="mCancel">Cancel</button><button class="primary" id="mOk">' + esc(okLabel || "OK") + "</button></div></div>";
      host.style.display = "grid";
      var close = function (ok) { host.style.display = "none"; host.innerHTML = ""; if (ok) resolve(); };
      $("#mCancel").onclick = function () { close(false) };
      $("#mOk").onclick = async function () {
        if (onOk) { try { await onOk(); close(true) } catch (e) { toast(String(e), "err") } }
        else close(true);
      };
    });
  }
  window.modal = modal;
  var PALETTE = [
    ["Go to Chat", function () { showView("chat") }],
    ["Go to Overview", function () { showView("overview") }],
    ["Go to Sessions", function () { showView("sessions") }],
    ["Go to Minions", function () { showView("minions") }],
    ["Go to Scheduler", function () { showView("scheduler") }],
    ["Go to Memory", function () { showView("memory") }],
    ["Go to Tools", function () { showView("tools") }],
    ["Go to Devices", function () { showView("devices") }],
    ["Go to Settings", function () { showView("settings") }],
    ["Go to Logs", function () { showView("logs") }],
    ["Go to Realtime", function () { showView("realtime") }],
    ["New chat session", function () { showView("sessions"); setTimeout(function () { var b = $("#newSessBtn"); if (b) b.click() }, 100) }],
    ["Dispatch minion task", function () { showView("minions"); setTimeout(function () { var f = $("#mTask"); if (f) f.focus() }, 50) }],
    ["Pair a new device", function () { showView("devices"); setTimeout(function () { var f = $("#pairKind"); if (f) f.focus() }, 50) }],
    ["Search memory", function () { showView("memory"); setTimeout(function () { var f = $("#mq"); if (f) f.focus() }, 50) }],
    ["Check for updates", function () { rpc("self.update", {}).then(function (r) { toast(r.upToDate ? "up to date" : String(r.message || "")) }, function (e) { toast(String(e), "err") }) }],
    ["Reconnect gateway", function () { window.OH.reconnect(); toast("reconnecting") }]
  ];
  var palOpen = false;
  function palette() {
    if (palOpen) return;
    palOpen = true;
    var host = $("#modalHost");
    host.innerHTML = '<div class="card" id="palette"><input id="palInput" placeholder="type a command..." autocomplete="off"><div id="palList"></div></div>';
    host.style.display = "grid";
    var sel = 0;
    function close() { palOpen = false; host.style.display = "none"; host.innerHTML = "" }
    function render() {
      var q = $("#palInput").value.toLowerCase();
      var items = PALETTE.filter(function (p) { return p[0].toLowerCase().indexOf(q) >= 0 });
      $("#palList").innerHTML = items.map(function (p, i) { return "<div class='prow " + (i === 0 ? "on" : "") + "'>" + esc(p[0]) + "</div>" }).join("") || "<div class='dim' style='padding:10px'>no matches</div>";
      sel = 0;
      $$("#palList .prow").forEach(function (r, i) {
        r.onclick = function () { close(); var found = PALETTE.find(function (x) { return x[0] === r.textContent }); if (found) found[1]() };
      });
    }
    render();
    $("#palInput").oninput = render;
    $("#palInput").onkeydown = function (e) {
      var rows = $$("#palList .prow");
      if (e.key === "ArrowDown") sel = Math.min(sel + 1, rows.length - 1);
      else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
      else if (e.key === "Enter") { if (rows[sel]) rows[sel].click(); return }
      else if (e.key === "Escape") { close(); return }
      else return;
      e.preventDefault();
      rows.forEach(function (x, i) { x.classList.toggle("on", i === sel) });
    };
    host.onclick = function (e) { if (e.target === host) close() };
    $("#palInput").focus();
  }
  document.addEventListener("DOMContentLoaded", function () {
    $$(".nav button").forEach(function (b) { b.onclick = function () { showView(b.dataset.view) } });
    $("#menuBtn").onclick = function () { document.querySelector("#sidebar").classList.toggle("open") };
    $("#newChatBtn").onclick = async function () {
      try { var s = await rpc("sessions.create", { title: "chat " + fmtT(Date.now()) }); await loadSessionsCount(); await openChat(s.id); showView("chat") } catch (e) { toast(String(e), "err") }
    };
    $("#sendBtn").onclick = function () { if (sending) stopChat(); else sendChat(); };
    var mb2 = $("#micBtn"); if (mb2) mb2.onclick = function () { micToggle() };
    var sb2 = $("#speakBtn");
    if (sb2) {
      sb2.classList.toggle("on", V.autoSpeak);
      sb2.onclick = function () {
        V.autoSpeak = !V.autoSpeak;
        localStorage.setItem("oh.autospeak", V.autoSpeak ? "1" : "0");
        sb2.classList.toggle("on", V.autoSpeak);
        sb2.title = V.autoSpeak ? "auto-speak replies: on" : "auto-speak replies: off";
        toast("auto-speak " + (V.autoSpeak ? "on" : "off"), "ok");
      };
    }
    if (window.OH.onEvent) window.OH.onEvent("voice.settings", function () { loadVoiceCard(); });
    $("#chatInput").addEventListener("keydown", function (e) {
      if (slashOpen()) {
        if (e.key === "Escape") { e.preventDefault(); slashHide(); return }
        if (e.key === "Tab" || e.key === "Enter") {
          if (e.key === "Enter" && ("/" + slashList[slashSel]) === this.value.trim()) { slashHide() }
          else { e.preventDefault(); slashPick(this); return }
        } else if (e.key === "ArrowUp") { e.preventDefault(); slashMove(-1); return }
        else if (e.key === "ArrowDown") { e.preventDefault(); slashMove(1); return }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); return }
      if (e.key === "ArrowUp" && this.selectionStart === 0 && this.selectionEnd === 0 && this.value.indexOf("\n") === -1) {
        if (histIdx === -1) { if (!hist.length) return; histDraft = this.value; histIdx = hist.length - 1 }
        else if (histIdx === 0) { e.preventDefault(); return }
        else histIdx--;
        this.value = hist[histIdx] || ""; e.preventDefault(); this.setSelectionRange(this.value.length, this.value.length); this.style.height = Math.min(this.scrollHeight, 200) + "px";
      } else if (e.key === "ArrowDown" && histIdx >= 0) {
        if (histIdx >= hist.length - 1) { histIdx = -1; this.value = histDraft }
        else { histIdx++; this.value = hist[histIdx] || "" }
        e.preventDefault(); this.style.height = Math.min(this.scrollHeight, 200) + "px";
      }
    });
    $("#chatInput").addEventListener("input", function () { slashCheck(this); this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 200) + "px" });
    $("#paletteBtn").onclick = palette;
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette() }
    });
    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-openview],[data-open],[data-openchat],[data-mshow],[data-mkill],[data-jrun],[data-jdis],[data-jdel],[data-tyes],[data-trem],[data-tno],[data-grev],[data-prev],[data-ack]") : null;
      if (!el) return;
      var d = el.dataset;
      if (d.openview) showView(d.openview);
      else if (d.open) openChat(d.open);
      else if (d.openchat) { openChat(d.openchat); showView("chat") }
      else if (d.mshow) showMinion(d.mshow);
      else if (d.mkill) rpc("agents.kill", { id: d.mkill }).then(function () { toast("killed " + String(d.mkill).slice(0, 6)); loadMinions() }, function (e2) { toast(String(e2), "err") });
      else if (d.jrun) rpc("schedule.runNow", { id: d.jrun }).then(function (r) { toast(r.ok ? "running" + (r.id ? " " + String(r.id).slice(0, 6) : "") : String(r.error), r.ok ? "" : "err"); loadScheduler() });
      else if (d.jdis) rpc("schedule.setDisabled", { id: d.jdis, disabled: d.dis === "true" }).then(loadScheduler);
      else if (d.jdel) rpc("schedule.remove", { id: d.jdel }).then(loadScheduler);
      else if (d.tyes) toolRespond(d.tyes, true, false);
      else if (d.trem) toolRespond(d.trem, true, true);
      else if (d.tno) toolRespond(d.tno, false, false);
      else if (d.grev) { var parts = d.grev.split("|"); rpc("grants.revoke", { deviceId: parts[0], tool: parts[1] }).then(function () { toast("revoked"); loadTools() }, function (e2) { toast(String(e2), "err") }) }
      else if (d.prev) rpc("pairing.revoke", { id: d.prev }).then(function () { toast("revoked"); loadDevices() });
      else if (d.ack) rpc("alerts.ack", { id: d.ack }).then(function () { toast("alert acked"); loadOverview() });
    });
    async function toolRespond(id, approved, remember) {
      try { await rpc("tools.respond", { id: id, approved: approved, remember: remember }); toast(approved ? "approved" : "denied"); loadTools() } catch (e) { toast(String(e), "err") }
    }
    window.OH.onEvent = function (topic, data) {
      if (topic === "chat.stream") {
        if (S.streaming && data && data.sessionId === S.session) {
          var liveBubble = S.streaming.parentElement;
          if (data.reasoning) {
            S.think = (S.think || "") + (data.tok || "");
            var pre = liveBubble && liveBubble.querySelector("details.think pre");
            if (pre) pre.textContent = S.think.length > 4000 ? S.think.slice(-4000) : S.think;
            $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
          } else if (data.tok) {
            S.streaming.dataset.buf = (S.streaming.dataset.buf || "") + data.tok;
            S.streaming.innerHTML = md(S.streaming.dataset.buf);
            $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
          }
        }
      } else if (topic === "sessions.changed") { loadSessionsCount(); if (S.view === "sessions") loadSessions(); }
      else if (topic === "settings.changed") { rpc("settings.get", {}).then(function (st) { S.settings = st; renderModelPill(); if (S.view === "settings") loadSettings() }).catch(function () { }) }
      else if (topic === "chat.tool") {
        if (S.streaming && data && data.sessionId === S.session) {
          var tb = S.streaming.parentElement;
          if (tb) {
            var host = tb.querySelector(".stepsbody"); var det = tb.querySelector("details.steps");
            if (!host) { det = document.createElement("details"); det.className = "steps"; det.open = true; det.innerHTML = '<summary>\u2699 Ran <span class="n">1</span> step</summary><div class="stepsbody"></div>'; tb.insertBefore(det, S.streaming); host = det.querySelector(".stepsbody"); }
            var sig = data.tool + "|" + JSON.stringify(data.args || {});
            var prev = null;
            for (var i = host.children.length - 1; i >= 0; i--) { if (host.children[i].dataset.sig === sig) { prev = host.children[i]; break } }
            var line = document.createElement("div"); line.className = "stepline"; line.dataset.sig = sig;
            if (data.status === "running") { line.classList.add("run"); line.textContent = "\u25d0 " + data.tool; if (prev) prev.replaceWith(line); else host.appendChild(line); }
            else { line.innerHTML = stepLine(data); if (prev) prev.replaceWith(line); else host.appendChild(line); }
            var nEl = det.querySelector(".n"); if (nEl) nEl.textContent = String(host.children.length);
            var tmt = tb.querySelector(".meta"); if (tmt) { var tg = tmt.querySelector(".badge.live"); if (!tg) { tg = document.createElement("span"); tg.className = "badge live"; tmt.appendChild(tg); } tg.textContent = "\u2699 " + data.tool; }
            $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
          }
        }
      }
      else if (topic === "agents.changed") { if (S.view === "overview") loadOverview(); else if (S.view === "minions") loadMinions(); else S.minions = []; }
      else if (topic === "device.up" || topic === "device.down") { if (S.view === "devices") loadDevices(); else if (S.view === "overview") loadOverview() }
      else if (topic === "tools.ask") { toast("a device wants to run a tool", ""); if (S.view === "tools") loadTools() }
      else if (topic === "alert.fired") { toast("alert: " + ((data && data.name) || "service") + " is down", "err"); if (S.view === "overview") loadOverview() }
      else if (topic === "alert.resolved") { toast("resolved: " + ((data && data.name) || "service") + " is back up", "ok"); if (S.view === "overview") loadOverview() }
      else if (topic === "memory.added") { if (S.view === "memory") doMemoryBrowse() }
    };
    var everOpen = false;
    window.OH.onOpen = async function () {
      everOpen = true;
      $("#connDot").classList.add("on");
      $("#tokenGate").classList.add("hidden");
      $("#app").classList.remove("hidden");
      if (!S.settings) { try { S.settings = await rpc("settings.get", {}) } catch (e) { } }
      renderModelPill();
      await loadSessionsCount();
      if (!S.loaded) { S.loaded = true; await openChat(S.session); showView("chat") }
    };
    window.OH.onClose = function () { $("#connDot").classList.remove("on") };
    function showGate(msg) {
      $("#tokenGate").classList.remove("hidden");
      $("#app").classList.add("hidden");
      $("#tokenErr").textContent = msg || "";
      setTimeout(function () { $("#tokenInput").focus() }, 100);
      loadAuthInfo();
    }
    var authInfo = null;
    async function loadAuthInfo() {
      try { authInfo = await (await fetch("/auth/info")).json(); } catch (e) { return; }
      var pw = $("#pwRow"), orow = $("#oauthRow");
      if (!pw || !authInfo || authInfo.ok === false) return;
      pw.classList.toggle("hidden", !authInfo.hasPassword);
      if (orow && authInfo.providers) {
        orow.innerHTML = authInfo.providers.map(function (p) {
          return "<button class='ghost' style='margin-right:6px' data-oauth='" + esc(p.name) + "'>continue with " + esc(p.name) + "</button>";
        }).join("");
      }
    }
    document.addEventListener("click", function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest("[data-oauth]") : null;
      if (b) location.href = "/oauth/" + b.dataset.oauth + "/start";
    });
    $("#tokenBtn").onclick = doToken;
    $("#tokenInput").addEventListener("keydown", function (e) { if (e.key === "Enter") doToken() });
    var pwB = $("#pwBtn");
    if (pwB) pwB.onclick = doPw;
    var pwI = $("#pwInput");
    if (pwI) pwI.addEventListener("keydown", function (e) { if (e.key === "Enter") doPw() });
    async function doPw() {
      var v = $("#pwInput").value;
      if (!v) return showGate("enter the password");
      $("#tokenErr").textContent = "signing in...";
      try {
        var r = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: v }) });
        var j = await r.json();
        if (!j.ok) { showGate(j.error || "login failed"); return; }
        everOpen = false;
        window.OH.reconnect();
        setTimeout(function () { if (!everOpen) showGate("signed in but handshake failed") }, 2500);
      } catch (e) { showGate("login failed: " + e.message) }
    }
    async function doToken() {
      var v = $("#tokenInput").value.trim();
      if (!v) return showGate("paste the token first");
      window.OH.setToken(v);
      everOpen = false;
      $("#tokenErr").textContent = "connecting...";
      window.OH.reconnect();
      setTimeout(function () { if (!everOpen) showGate("not connected — check the token") }, 2500);
    }
    window.OH.connect();
    setTimeout(function () {
      if (!everOpen) showGate(localStorage.getItem("oh.token") ? "not connected — check the token" : "");
    }, 1500);
    setInterval(function () {
      if (S.view === "minions") loadMinions();
      else if (S.view === "tools") loadTools();
      else if (S.view === "overview") loadOverview();
    }, 3000);
  });
})();