// O-Harness browser client: persistent ws, rpc, events
(function () {
  var OH = { ws: null, reqs: {}, id: 0, onEvent: function () { }, onOpen: null, onClose: null, authFail: null };
  var P = new URLSearchParams(location.search);
  var TOKEN_KEY = "oh.token";
  var SECRET_KEY = "oh.secret";
  var tok = localStorage.getItem(TOKEN_KEY) || "";
  if (P.get("token")) { tok = P.get("token"); localStorage.setItem(TOKEN_KEY, tok); }
  OH.getToken = function () { return tok; };
  OH.setToken = function (t) { tok = t; localStorage.setItem(TOKEN_KEY, t); };
  function url() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var q = "api?token=" + encodeURIComponent(tok);
    if (localStorage.getItem(SECRET_KEY)) q += "&secret=" + encodeURIComponent(localStorage.getItem(SECRET_KEY));
    return proto + "://" + location.host + "/" + q;
  }
  function connect() {
    if (OH.ws && (OH.ws.readyState === 0 || OH.ws.readyState === 1)) return;
    var ws = new WebSocket(url());
    OH.ws = ws;
    ws.onopen = function () { if (OH.onOpen) OH.onOpen(); };
    ws.onclose = function () {
      if (OH.ws === ws) {
        OH.ws = null;
        if (OH.onClose) OH.onClose();
        setTimeout(connect, 1500);
      }
    };
    ws.onerror = function () { };
    ws.onmessage = function (ev) {
      var m = null; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || !m.type) return;
      if (m.type === "rpc:res") {
        var r = OH.reqs[m.id];
        if (r) {
          delete OH.reqs[m.id]; clearTimeout(r.timer);
          if (m.error) r.rej(m.error); else r.res(m.result);
        }
      } else if (m.type === "event") {
        OH.onEvent(m.topic, m.data);
      }
    };
  }
  OH.rpc = function (method, params) {
    return new Promise(function (resolve, reject) {
      var id = "w" + (++OH.id) + "-" + Date.now();
      var timer = setTimeout(function () { delete OH.reqs[id]; reject("timeout: " + method); }, 300000);
      OH.reqs[id] = { res: resolve, rej: reject, timer: timer };
      var send = function () { OH.ws.send(JSON.stringify({ type: "rpc:req", id: id, method: method, params: params })) };
      if (OH.ws && OH.ws.readyState === 1) send();
      else {
        var old = OH.onOpen, done = false;
        OH.onOpen = function () { if (old) old(); if (!done) { done = true; send(); } };
        connect();
      }
    });
  };
  OH.reconnect = function () { if (OH.ws) { var w = OH.ws; OH.ws = null; w.close(); } else connect(); };
  OH.connect = connect;
  window.OH = OH;
})();
