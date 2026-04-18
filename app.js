/**
 * Race Founders Proxy — RKC Live Timing v4
 * =========================================
 * Format messages confirmé :
 *   init : grid||<tbody>...</tbody>  → HTML avec noms, numéros, positions
 *   live : r[ID]c4|dr|NOM           → nom équipe
 *          r[ID]c4|drteam|NOM [t]   → nom pilote avec temps en piste
 *          r[ID]c5|ib|ECART         → écart
 *          r[ID]c6|in|INTERV        → intervalle
 *          r[ID]c9|tn|S1            → secteur 1
 *          r[ID]c10|tn|BT           → meilleur tour
 *          r[ID]c12|to|TPS          → temps en piste
 *          r[ID]c13|tn|DT           → dernier tour
 *          r[ID]c14|in|STANDS       → nb passages stands
 *          r[ID]|*i[N]|GAP          → position N, écart GAP ms
 *          dyn1|countdown|MS        → temps restant en ms
 */

const http      = require("http");
const WebSocket = require("ws");

const APEX_WS_URL  = "wss://www.apex-timing.com:7913/";
const OUR_KART_NUM = process.env.OUR_KART || "42";

const APEX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Origin":  "https://www.apex-timing.com",
  "Referer": "https://www.apex-timing.com/live-timing/rkc/",
  "Host":    "www.apex-timing.com:7913",
};

let karts          = {};
let countdown_ms   = 0;
let raceStarted    = false;
let sessionTitle   = "";
let trackName      = "";
let lastUpdate     = null;
let rawLog         = [];
let connectionTime = null;
let comments       = [];

// ── PARSE HTML INITIAL ────────────────────────────────────────────────────────
function parseGridHtml(html) {
  var rowRe = /data-id="r(\d+)"\s+data-pos="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  var match;
  var count = 0;
  while ((match = rowRe.exec(html)) !== null) {
    var kartId  = match[1];
    var pos     = parseInt(match[2]);
    var rowHtml = match[3];
    if (kartId === "0") continue;
    var kart = ensureKart(kartId);
    kart.pos = pos;
    // c4 = numéro kart affiché
    var c4 = rowHtml.match(/data-id="r\d+c4"[^>]*>([^<]*)</);
    if (c4 && c4[1].trim()) kart.kartNum = c4[1].trim();
    // c5 = nom équipe/pilote
    var c5 = rowHtml.match(/data-id="r\d+c5"[^>]*>([^<]+)</);
    if (c5 && c5[1].trim()) kart.driver = c5[1].trim();
    // c12 = meilleur tour
    var c12 = rowHtml.match(/data-id="r\d+c12"[^>]*>([^<]*)</);
    if (c12 && c12[1].trim()) kart.bestLap = c12[1].trim();
    // c13 = dernier tour
    var c13 = rowHtml.match(/data-id="r\d+c13"[^>]*>([^<]*)</);
    if (c13 && c13[1].trim()) kart.lastLap = c13[1].trim();
    // c14 = stands
    var c14 = rowHtml.match(/data-id="r\d+c14"[^>]*>([^<]*)</);
    if (c14 && c14[1].trim()) kart.pits = parseInt(c14[1].trim()) || 0;
    // statut
    var c1cls = rowHtml.match(/data-id="r\d+c1"\s+class="([^"]+)"/);
    if (c1cls) kart.status = c1cls[1];
    count++;
  }
  console.log("[Grid] " + count + " karts parsés depuis HTML");
}

// ── ÉTAT KART ─────────────────────────────────────────────────────────────────
function ensureKart(id) {
  if (!karts[id]) {
    karts[id] = {
      id:id, pos:99, kartNum:"", driver:"", gap:"", interval:"",
      lastLap:"", bestLap:"", laps:0, pits:0, status:"", onTrack:"",
    };
  }
  return karts[id];
}

function fmtMs(ms) {
  var s  = Math.floor(Math.abs(ms) / 1000);
  var h  = Math.floor(s / 3600);
  var m  = Math.floor((s % 3600) / 60);
  var sc = s % 60;
  return (ms < 0 ? "-" : "") +
    String(h).padStart(2,"0") + ":" +
    String(m).padStart(2,"0") + ":" +
    String(sc).padStart(2,"0");
}

// ── PARSE MESSAGES LIVE ───────────────────────────────────────────────────────
function parseMessage(raw) {
  rawLog.push(raw.substring(0, 300));
  if (rawLog.length > 30) rawLog.shift();

  var lines = raw.split("\n");
  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;

    // Paquet HTML initial
    if (line.startsWith("grid||")) {
      parseGridHtml(line.substring(6));
      return;
    }
    // Titre session
    if (line.startsWith("title1||")) { sessionTitle = line.substring(8); return; }
    if (line.startsWith("title2||")) { sessionTitle += " — " + line.substring(8); return; }
    if (line.startsWith("track||"))  { trackName = line.substring(7); return; }
    // Commentaires
    if (line.startsWith("com||")) {
      var txt = line.substring(5).replace(/<[^>]+>/g, " ").trim();
      if (txt) comments = txt.split("  ").filter(Boolean).slice(0, 5);
      return;
    }
    // Compte à rebours
    if (line.includes("dyn1|countdown|")) {
      var cm = line.match(/dyn1\|countdown\|(\d+)/);
      if (cm) { countdown_ms = parseInt(cm[1]); raceStarted = true; }
    }
    // Updates karts
    var tokens = line.split(" ");
    tokens.forEach(function(token) {
      token = token.trim();
      if (token.startsWith("r")) parseKartToken(token);
    });
  });

  lastUpdate = new Date().toISOString();
}

function parseKartToken(token) {
  if (!token || !token.startsWith("r")) return;
  var m = token.match(/^r(\d+)(c\d+)?\|([^|]*)\|(.*)$/);
  if (!m) return;

  var kartId = m[1];
  var col    = m[2] || "";
  var type   = m[3];
  var value  = m[4].trim();

  var kart = ensureKart(kartId);

  // Position
  if (type === "*out") { kart.status = "out"; return; }
  if (type === "*") { return; } // format alternatif ignoré
  if (type.startsWith("*i")) {
    kart.pos = parseInt(type.substring(2)) || kart.pos;
    if (value) {
      var g = parseInt(value);
      kart.gap = isNaN(g) ? value : (g === 0 ? "Leader" : "+" + (g/1000).toFixed(3) + "s");
    }
    return;
  }

  switch(col) {
    case "c1":
      kart.status = type || kart.status;
      break;
    case "c4":
      // dr / drteam = nom équipe ou pilote
      if (type === "dr" || type === "drteam") {
        if (value) kart.driver = value.trim();
      } else {
        // numéro de kart affiché
        if (value) kart.kartNum = value;
      }
      break;
    case "c5":
      // écart (gap) en live
      if (value && (type === "ib" || type === "in")) kart.gap = value;
      break;
    case "c6":
      // intervalle
      if (value && type === "in") kart.interval = value;
      break;
    case "c9":
      if (value) kart.s1 = value;
      break;
    case "c10":
      // meilleur tour ou S2
      if (value) {
        if (value.indexOf(":") >= 0 || parseFloat(value) > 60) kart.bestLap = value;
        else kart.s2 = value;
      }
      break;
    case "c11":
      if (value) kart.s3 = value;
      break;
    case "c12":
      if (type === "to") {
        kart.onTrack = value;
      } else if (value && (type === "tb" || type === "in" || type === "tn")) {
        kart.bestLap = value;
      }
      break;
    case "c13":
      if (value && (type === "tn" || type === "ti")) {
        kart.lastLap = value;
        if (type === "tn") kart.laps = (kart.laps || 0) + 1;
      }
      break;
    case "c14":
      if (value) kart.pits = parseInt(value) || kart.pits;
      break;
  }
}

// ── BUILD STATE ───────────────────────────────────────────────────────────────
function buildState() {
  var entries = Object.values(karts)
    .filter(function(k) { return k.pos < 99 || k.driver || k.kartNum; })
    .sort(function(a, b) { return a.pos - b.pos; })
    .map(function(k) {
      // Nettoyer le nom (enlever [0:28] du drteam)
      var driver = k.driver ? k.driver.replace(/\s*\[\d+:\d+\]$/, "").trim() : "";
      var kartNum = k.kartNum || k.id;
      return {
        pos:     k.pos,
        kart:    kartNum,
        driver:  driver || ("Kart " + kartNum),
        lastLap: k.lastLap || "",
        bestLap: k.bestLap || "",
        laps:    k.laps    || 0,
        gap:     k.gap     || "",
        interval:k.interval|| "",
        pits:    k.pits    || 0,
        status:  k.status  || "",
        onTrack: k.onTrack || "",
      };
    });

  // Cherche notre kart par numéro affiché
  var ourTeam = entries.find(function(e) {
    return String(e.kart) === OUR_KART_NUM;
  }) || null;

  return {
    connected:    true,
    raceActive:   raceStarted,
    sessionTitle: sessionTitle,
    trackName:    trackName,
    timeRemaining:countdown_ms > 0 ? fmtMs(countdown_ms) : "—",
    countdown_ms: countdown_ms,
    lastUpdate:   lastUpdate,
    connectionTime:connectionTime,
    totalKarts:   entries.length,
    ourKart:      OUR_KART_NUM,
    comments:     comments,
    entries:      entries,
    ourTeam:      ourTeam,
  };
}

// ── WEBSOCKET APEX ────────────────────────────────────────────────────────────
var apexWs = null;
var reconnectTimer = null;
var clients = new Set();

function broadcast(msg) {
  var json = JSON.stringify(msg);
  clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function connectToApex() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionTime = new Date().toISOString();
  console.log("[Apex] Connexion...");
  try { apexWs = new WebSocket(APEX_WS_URL, { headers: APEX_HEADERS }); }
  catch(e) { reconnectTimer = setTimeout(connectToApex, 8000); return; }
  apexWs.on("open", function() { console.log("[Apex] Connecté ! Kart: " + OUR_KART_NUM); });
  apexWs.on("message", function(data) {
    parseMessage(data.toString());
    broadcast({ type: "update", data: buildState() });
  });
  apexWs.on("close", function() {
    reconnectTimer = setTimeout(connectToApex, 5000);
    broadcast({ type: "disconnected" });
  });
  apexWs.on("error", function(err) { console.error("[Apex]", err.message); });
}

// ── SERVEUR HTTP ──────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  var url = (req.url || "/").split("?")[0];

  if (url === "/status") return res.end(JSON.stringify({
    ok: true,
    apexConnected:  apexWs && apexWs.readyState === WebSocket.OPEN,
    ourKart:        OUR_KART_NUM,
    raceActive:     raceStarted,
    sessionTitle:   sessionTitle,
    trackName:      trackName,
    timeRemaining:  fmtMs(countdown_ms),
    kartsTracked:   Object.keys(karts).length,
    kartsWithNames: Object.values(karts).filter(function(k){return k.driver;}).length,
    lastUpdate:     lastUpdate,
    connectionTime: connectionTime,
    dashboardClients: clients.size,
  }, null, 2));

  if (url === "/race")      return res.end(JSON.stringify(buildState(), null, 2));
  if (url === "/raw")       return res.end(JSON.stringify({ messages: rawLog }, null, 2));
  if (url === "/karts")     return res.end(JSON.stringify(Object.values(karts).sort(function(a,b){return a.pos-b.pos;}), null, 2));

  if (url === "/reconnect") {
    karts = {}; countdown_ms = 0; raceStarted = false; comments = [];
    if (apexWs) { try { apexWs.close(); } catch(e) {} }
    setTimeout(connectToApex, 500);
    return res.end(JSON.stringify({ ok: true, message: "Reconnexion en cours — attendre 3s" }));
  }

  res.end(JSON.stringify({
    name: "Race Founders Proxy v4 — RKC",
    ourKart: OUR_KART_NUM,
    endpoints: { "/status":"État", "/race":"Classement", "/raw":"Messages bruts", "/karts":"Karts détaillés", "/reconnect":"Reset+reconnexion" }
  }, null, 2));
});

var wss = new WebSocket.Server({ server });
wss.on("connection", function(ws) {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "update", data: buildState() }));
  ws.on("close", function() { clients.delete(ws); });
  ws.on("error", function() { clients.delete(ws); });
});

var PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log("Race Founders Proxy v4 | Port:" + PORT + " | Kart:#" + OUR_KART_NUM);
  connectToApex();
});
