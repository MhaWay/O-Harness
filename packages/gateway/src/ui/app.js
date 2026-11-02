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
      if (line.slice(0, 3) === "~~~") {
        i++; var code = [];
        while (i < lines.length && lines[i].slice(0, 3) !== "~~~") { code.push(lines[i]); i++ }
        i++;
        out.push("<pre><code>" + esc(code.join(NL)) + "</code></pre>");
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
      var para = [];
      while (i < lines.length && lines[i].trim() && lines[i].slice(0, 3) !== "~~~" && lines[i].charAt(0) !== "#") { para.push(lines[i]); i++ }
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
    devices: loadDevices, settings: loadSettings, chat: null
  };
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
  async function openChat(sessionId) {
    S.session = sessionId;
    renderMiniSessions();
    var log = $("#chatLog"); log.innerHTML = "";
    try {
      var h = await rpc("chat.history", { sessionId: sessionId });
      if (!h || !h.length) log.appendChild(bubble("assistant", '<p class="dim">(no messages yet)</p>'));
      else h.forEach(function (e) {
        var tools = (e.tools || []).map(function (t) { return '<span class="badge">' + esc(t) + "</span>" }).join("");
        log.appendChild(bubble(e.role, md(e.text), { mline: "<span>" + fmtT(e.ts) + "</span>" + tools }));
      });
      log.scrollTop = log.scrollHeight;
    } catch (e) { toast("history: " + e, "err") }
  }
  var sending = false;
  async function sendChat() {
    var input = $("#chatInput");
    var msg = input.value.trim();
    if (!msg || sending) return;
    sending = true; $("#sendBtn").disabled = true;
    input.value = ""; input.style.height = "auto";
    $("#chatLog").appendChild(bubble("user", md(msg), { mline: "<span>you</span>" }));
    var wait = bubble("assistant", '<span class="thinking"><i></i><i></i><i></i></span>');
    $("#chatLog").appendChild(wait);
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
    S.streaming = wait.querySelector(".md");
    S.streaming.dataset.buf = "";
    try {
      var r = await rpc("chat.send", { sessionId: S.session, message: msg, effort: $("#effortSel").value });
      if (S.streaming) S.streaming.innerHTML = md(r && r.text ? r.text : String(r || ""));
    } catch (e) {
      if (S.streaming) S.streaming.innerHTML = '<span class="dim">error: ' + esc(String(e)) + "</span>";
      toast(String(e), "err");
    }
    S.streaming = null; sending = false; $("#sendBtn").disabled = false;
    loadSessionsCount();
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  }
  window.sendChat = sendChat;
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
      '<h2 class="sec">Sessions</h2><div class="row"><button class="ghost" id="newSessBtn">+ New session</button></div>' +
      "<table><tr><th>title</th><th>id</th><th>entries</th><th>created</th><th></th></tr>" +
      S.sessions.slice().sort(function (a, b) { return b.createdAt - a.createdAt }).map(function (s) {
        return "<tr><td>" + esc(s.title) + "</td><td class='dim'>" + esc(String(s.id).slice(0, 8)) + "</td><td>" + (s.entryCount || 0) + "</td><td>" + fmtDT(s.createdAt) + "</td><td><button class='ghost' data-openchat='" + esc(s.id) + "'>open chat</button></td></tr>";
      }).join("") + "</table>";
    $("#newSessBtn").onclick = function () {
      modal("New session", '<div class="row"><input type="text" id="nsTitle" placeholder="session title" style="flex:1"></div>', async function () {
        var s = await rpc("sessions.create", { title: $("#nsTitle").value || "chat" });
        await loadSessionsCount(); await openChat(s.id); showView("chat");
      }, "Create");
      setTimeout(function () { $("#nsTitle").focus() }, 50);
    };
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
  async function loadSettings() {
    var st = S.settings = await rpc("settings.get", {});
    var def = st.default || {};
    var byId = {}; (st.providers || []).forEach(function (p) { byId[p.id] = p });
    var rows = (st.providers || []).map(function (p, i) {
      var modelNames = ((p.extra && p.extra.models) || []).slice();
      if (!modelNames.length && p.modelId) modelNames = [p.modelId];
      return '<tr data-pid="' + esc(p.id) + '">' +
        "<td><input type='text' data-f='name' value='" + esc(p.name) + "' style='width:140px'></td>" +
        "<td><input type='text' data-f='url' value='" + esc(p.url) + "' style='width:230px'></td>" +
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
      "<div class='row' style='margin-top:12px'><button class='ghost' id='addProv'>+ Add provider</button><button class='primary' id='saveProv'>Save settings</button><span id='setOut' class='dim'></span></div>";
    function fillModel(sel, names, cur) {
      sel.innerHTML = names.map(function (n) { return "<option>" + esc(n) + "</option>" }).join("") || "<option>(none)</option>";
      if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    }
    var defProv = $("#defProv");
    function defModels() {
      var p = byId[defProv.value] || {};
      var names = ((p.extra && p.extra.models) || []).slice();
      if (!names.length && p.modelId) names = [p.modelId];
      fillModel($("#defModel"), names, def.modelId || (names.length ? names[0] : ""));
    }
    defModels();
    defProv.onchange = function () { def.modelId = null; defModels() };
    $("#addProv").onclick = function () {
      var id = prompt("provider id (lowercase, unique)", "my-provider"); if (!id) return;
      id = id.trim().toLowerCase().split(/[^a-z0-9-]/).filter(Boolean).join("-");
      if (byId[id]) return toast("id exists", "err");
      S.settings.providers.push({ id: id, name: id, url: "http://127.0.0.1:8000/v1" });
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
          S.settings.providers[i].extra = S.settings.providers[i].extra || {};
          S.settings.providers[i].extra.models = names;
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
        p.name = v("name") || p.name; p.url = v("url") || p.url;
        var k = v("key"); if (k && k.indexOf("*") < 0) p.apiKey = k;
        var m = v("model"); if (m) p.modelId = m;
        var sel = tr.querySelector("[data-f=model]");
        if (sel.options.length > 1) { p.extra = p.extra || {}; p.extra.models = [].slice.call(sel.options).map(function (o) { return o.value }) }
      });
      S.settings.default = { providerId: defProv.value, modelId: $("#defModel").value, effort: $("#defEffort").value };
      S.settings.allowSelfUpdate = $("#allowUp").checked;
    }
    $("#saveProv").onclick = async function () {
      collect();
      try { await rpc("settings.save", { settings: S.settings }); $("#setOut").textContent = "saved " + fmtT(Date.now()); toast("settings saved", "ok") } catch (e) { toast(String(e), "err") }
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
    $("#sendBtn").onclick = sendChat;
    $("#chatInput").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat() } });
    $("#chatInput").addEventListener("input", function () { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 200) + "px" });
    $("#paletteBtn").onclick = palette;
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette() }
    });
    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-openview],[data-open],[data-openchat],[data-mshow],[data-mkill],[data-jrun],[data-jdis],[data-jdel],[data-tyes],[data-trem],[data-tno],[data-grev],[data-prev]") : null;
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
    });
    async function toolRespond(id, approved, remember) {
      try { await rpc("tools.respond", { id: id, approved: approved, remember: remember }); toast(approved ? "approved" : "denied"); loadTools() } catch (e) { toast(String(e), "err") }
    }
    window.OH.onEvent = function (topic, data) {
      if (topic === "chat.stream") {
        if (S.streaming && data && data.sessionId === S.session && data.tok) {
          S.streaming.dataset.buf = (S.streaming.dataset.buf || "") + data.tok;
          S.streaming.innerHTML = md(S.streaming.dataset.buf);
          $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
        }
      } else if (topic === "sessions.changed") loadSessionsCount();
      else if (topic === "agents.changed") { if (S.view === "overview") loadOverview(); else if (S.view === "minions") loadMinions(); else S.minions = []; }
      else if (topic === "device.up" || topic === "device.down") { if (S.view === "devices") loadDevices(); else if (S.view === "overview") loadOverview() }
      else if (topic === "tools.ask") { toast("a device wants to run a tool", ""); if (S.view === "tools") loadTools() }
      else if (topic === "memory.added") { if (S.view === "memory") doMemoryBrowse() }
    };
    var everOpen = false;
    window.OH.onOpen = async function () {
      everOpen = true;
      $("#connDot").classList.add("on");
      $("#tokenGate").classList.add("hidden");
      $("#app").classList.remove("hidden");
      if (!S.settings) { try { S.settings = await rpc("settings.get", {}) } catch (e) { } }
      await loadSessionsCount();
      if (!S.loaded) { S.loaded = true; await openChat(S.session); showView("chat") }
    };
    window.OH.onClose = function () { $("#connDot").classList.remove("on") };
    function showGate(msg) {
      $("#tokenGate").classList.remove("hidden");
      $("#app").classList.add("hidden");
      $("#tokenErr").textContent = msg || "";
      setTimeout(function () { $("#tokenInput").focus() }, 100);
    }
    $("#tokenBtn").onclick = doToken;
    $("#tokenInput").addEventListener("keydown", function (e) { if (e.key === "Enter") doToken() });
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