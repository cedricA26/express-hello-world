/**
 * Race Founders Proxy — RKC Live Timing v3
 * =========================================
 * Le paquet initial est du HTML : grid||<tbody>...</tbody>
 * Les noms sont dans : data-id="r[ID]c5" class="dr" → nom pilote
 * Les numéros kart  : data-id="r[ID]c4" → numéro affiché
 *
 * Colonnes confirmées :
 *   c4  = numéro de kart affiché (no)
 *   c5  = nom pilote (dr)
 *   c7  = écart / secteur (gap / ib)
 *   c8  = intervalle (int)
 *   c9  = S1, c10 = S2, c11 = S3
 *   c12 = meilleur tour (blp)
 *   c13 = dernier tour (llp / ti / tn)
 *   c14 = passages stands (pit)
 */

const http      = require("http");
const WebSocket = require("ws");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const APEX_WS_URL  = "wss://www.apex-timing.com:7913/";
const OUR_KART_NUM = process.env.OUR_KART || "42";

const APEX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Origin":  "https://www.apex-timing.com",
  "Referer": "https://www.apex-timing.com/live-timing/rkc/",
  "Host":    "www.apex-timing.com:7913",
};

// ── ÉTAT ─────────────────────────────────────────────────────────────────────
let karts          = {};
let countdown_ms   = 0;
let raceStarted    = false;
let sessionTitle   = "";
let trackName      = "";
let lastUpdate     = null;
let rawLog         = [];
let initHtml       = "";
let connectionTime = null;
let comments       = [];

// ── PARSING HTML INITIAL ──────────────────────────────────────────────────────
/**
 * Parse le paquet grid||<tbody>...</tbody>
 * Extrait : kartId → { kartNum, driver, pos, bestLap, lastLap, pits }
 */
function parseGridHtml(html) {
  // Regex pour chaque ligne <tr data-id="r[ID]" data-pos="[POS]">
  const rowRe = /data-id="r(\d+)"\s+data-pos="(\d+)"[^>]*>(.*?)<\/tr>/gs;
  let match;
  let count = 0;

  while ((match = rowRe.exec(html)) !== null) {
    const kartId  = match[1];
    const pos     = parseInt(match[2]);
    const rowHtml = match[3];

    if (kartId === "0") continue; // ligne header

    const kart = ensureKart(kartId);
    kart.pos   = pos;

    // c4 = numéro kart
    const c4 = rowHtml.match(/data-id="r\d+c4"[^>]*>([^<]*)</);
    if (c4 && c4[1].trim()) kart.kartNum = c4[1].trim();

    // c5 = nom pilote (class="dr")
    const c5 = rowHtml.match(/data-id="r\d+c5"[^>]*>([^<]+)</);
    if (c5 && c5[1].trim()) kart.driver = c5[1].trim();

    // c12 = meilleur tour
    const c12 = rowHtml.match(/data-id="r\d+c12"[^>]*>([^<]*)</);
    if (c12 && c12[1].trim()) kart.bestLap = c12[1].trim();

    // c13 = dernier tour
    const c13 = rowHtml.match(/data-id="r\d+c13"[^>]*>([^<]*)</);
    if (c13 && c13[1].trim()) kart.lastLap = c13[1].trim();

    // c14 = passages stands
    const c14 = rowHtml.match(/data-id="r\d+c14"[^>]*>([^<]*)</);
    if (c14 && c14[1].trim()) kart.pits = parseInt(c14[1].trim()) || 0;

    // c1 = statut (class=gs/gf/gl/gm/in)
    const c1cls = rowHtml.match(/data-id="r\d+c1"\s+class="([^"]+)"/);
    if (c1cls) kart.status = c1cls[1];

    count++;
  }
  console.log("[Grid] Parsé " + count + " karts depuis le HTML initial");
}

// ── PARSING MESSAGES LIVE ─────────────────────────────────────────────────────
function ensureKart(id) {
  if (!karts[id]) {
    karts[id] = {
      id, pos:99, kartNum:id, driver:"", gap:"", interval:"",
      lastLap:"", bestLap:"", laps:0, pits:0, status:"", sector:"",
    };
  }
  return karts[id];
}

function fmt_ms(ms) {
  const s  = Math.floor(Math.abs(ms) / 1000);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return (ms < 0 ? "-" : "") +
    String(h).padStart(2,"0") + ":" +
    String(m).padStart(2,"0") + ":" +
    String(sc).padStart(2,"0");
}

function parseMessage(raw) {
  rawLog.push(raw.substring(0, 300));
  if (rawLog.length > 30) rawLog.shift();

  const lines = raw.split("\n");

  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;

    // ── Paquet initial HTML ───────────────────────────────────────────────
    if (line.startsWith("grid||")) {
      const html = line.substring(6);
      initHtml = html;
      parseGridHtml(html);
      return;
    }

    // ── Titre de session ──────────────────────────────────────────────────
    if (line.startsWith("title1||")) { sessionTitle = line.substring(8); return; }
    if (line.startsWith("title2||")) { sessionTitle += " — " + line.substring(8); return; }
    if (line.startsWith("track||"))  { trackName = line.substring(7); return; }

    // ── Commentaires (contient les pénalités, départ, arrivée) ───────────
    if (line.startsWith("com||")) {
      const txt = line.substring(5).replace(/<[^>]+>/g, " ").trim();
      if (txt) comments = txt.split("  ").filter(Boolean).slice(0, 5);
      return;
    }

    // ── Compte à rebours ──────────────────────────────────────────────────
    if (line.includes("dyn1|countdown|")) {
      const m = line.match(/dyn1\|countdown\|(\d+)/);
      if (m) { countdown_ms = parseInt(m[1]); raceStarted = true; }
    }

    // ── Updates karts : r[ID]c[col]|type|value ───────────────────────────
    // Un message peut contenir plusieurs updates séparés par \n déjà splittés
    // mais aussi plusieurs sur la même ligne séparés par "r" suivant
    // On extrait tous les tokens r[ID]...
    const tokens = line.match(/r\d+(?:c\d+)?\|[^r]*/g) || [];
    tokens.forEach(function(token) {
      parseKartToken(token.trim());
    });
  });

  lastUpdate = new Date().toISOString();
}

function parseKartToken(token) {
  if (!token || !token.startsWith("r")) return;

  const m = token.match(/^r(\d+)(c\d+)?\|([^|]*)\|(.*)$/);
  if (!m) return;

  const kartId = m[1];
  const col    = m[2] || "";
  const type   = m[3];
  const value  = m[4].trim().replace(/\\n$/, "");

  const kart = ensureKart(kartId);

  // Position : *i2 = position 2, ou *|gap|interval, ou *out
  if (type === "*out") { kart.status = "out"; return; }
  if (type.startsWith("*i")) {
    kart.pos = parseInt(type.substring(2)) || kart.pos;
    if (value) {
      const g = parseInt(value);
      kart.gap = g === 0 ? "Leader" : (g > 0 ? "+" + (g/1000).toFixed(3) + "s" : value);
    }
    return;
  }
  if (type === "*") {
    // format: r[ID]|*|gap|interval
    const parts2 = (col + "|" + value).split("|").filter(Boolean);
    if (parts2[0]) {
      const g = parseInt(parts2[0]);
      if (!isNaN(g)) kart.gap = g === 0 ? "Leader" : "+" + (g/1000).toFixed(3) + "s";
    }
    return;
  }

  switch(col) {
    case "c1":  kart.status   = type || kart.status; break;
    case "c4":
      // drteam = nom équipe en course (ex: "NOUET Noah [0:28]")
      // dr     = nom équipe simple
      // sinon  = numéro de kart affiché
      if (type === "drteam" || type === "dr") {
        if (value) kart.driver = value.replace(/\s*\[[\d:]+\]\s*$/, "").trim();
      } else {
        if (value) kart.kartNum = value;
      }
      break;
    case "c5":  if(value) kart.driver = value; break;
    case "c7":  if(value) kart.gap      = value; break;
    case "c8":  if(value) kart.interval = value; break;
    case "c9":  if(value) kart.s1       = value; break;
    case "c10": if(value) kart.s2       = value; break;
    case "c11": if(value) kart.s3       = value; break;
    case "c12":
      if (type === "to") {
        kart.onTrack = value; // temps en piste
      } else if (value && (type === "tb" || type === "in" || type === "tn")) {
        kart.bestLap = value;
      }
      break;
    case "c13":
      if (value && (type === "tn" || type === "ti")) {
        kart.lastLap = value;
        // Incrémenter les tours si c'est un nouveau tour complet
        if (type === "tn") kart.laps = (kart.laps || 0) + 1;
      }
      break;
    case "c14":
      if (value) kart.pits = parseInt(value) || kart.pits;
      break;
  }
}

function buildState() {
  const entries = Object.values(karts)
    .filter(function(k) { return k.pos < 99 || k.driver; })
    .sort(function(a, b) { return a.pos - b.pos; })
    .map(function(k) {
      return {
        pos:     k.pos,
        kart:    k.kartNum || k.id,
        driver:  k.driver  || ("Kart " + (k.kartNum || k.id)),
        lastLap: k.lastLap || "",
        bestLap: k.bestLap || "",
        laps:    k.laps    || 0,
        gap:     k.gap     || "",
        pits:    k.pits    || 0,
        status:  k.status  || "",
      };
    });

  const ourTeam = entries.find(function(e) {
    return String(e.kart) === OUR_KART_NUM || String(e.kart).endsWith(OUR_KART_NUM);
  }) || null;

  return {
    connected:     true,
    raceActive:    raceStarted,
    sessionTitle,
    trackName,
    timeRemaining: countdown_ms > 0 ? fmt_ms(countdown_ms) : "—",
    countdown_ms,
    lastUpdate,
    connectionTime,
    totalKarts:    entries.length,
    ourKart:       OUR_KART_NUM,
    comments,
    entries,
    ourTeam,
  };
}

// ── WEBSOCKET APEX ────────────────────────────────────────────────────────────
let apexWs = null;
let reconnectTimer = null;
const clients = new Set();

function broadcast(msg) {
  const json = JSON.stringify(msg);
  clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

function connectToApex() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionTime = new Date().toISOString();
  console.log("[Apex] Connexion à " + APEX_WS_URL + " ...");

  try { apexWs = new WebSocket(APEX_WS_URL, { headers: APEX_HEADERS }); }
  catch(e) {
    console.error("[Apex] Erreur:", e.message);
    reconnectTimer = setTimeout(connectToApex, 8000);
    return;
  }

  apexWs.on("open", function() {
    console.log("[Apex] ✅ Connecté ! Notre kart: " + OUR_KART_NUM);
    broadcast({ type: "connected" });
  });

  apexWs.on("message", function(data) {
    parseMessage(data.toString());
    broadcast({ type: "update", data: buildState() });
  });

  apexWs.on("close", function(code) {
    console.log("[Apex] Fermé (" + code + ") — reconnexion dans 5s");
    reconnectTimer = setTimeout(connectToApex, 5000);
    broadcast({ type: "disconnected" });
  });

  apexWs.on("error", function(err) {
    console.error("[Apex] Erreur WS:", err.message);
  });
}

// ── SERVEUR HTTP ──────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const url = (req.url || "/").split("?")[0];

  if (url === "/status") {
    return res.end(JSON.stringify({
      ok:             true,
      apexConnected:  apexWs && apexWs.readyState === WebSocket.OPEN,
      ourKart:        OUR_KART_NUM,
      raceActive:     raceStarted,
      sessionTitle,
      trackName,
      timeRemaining:  fmt_ms(countdown_ms),
      kartsTracked:   Object.keys(karts).length,
      kartsWithNames: Object.values(karts).filter(function(k){return k.driver;}).length,
      lastUpdate,
      connectionTime,
      dashboardClients: clients.size,
    }, null, 2));
  }

  if (url === "/race") {
    return res.end(JSON.stringify(buildState(), null, 2));
  }

  if (url === "/karts") {
    const sorted = Object.values(karts).sort(function(a,b){return a.pos-b.pos;});
    return res.end(JSON.stringify({ total: sorted.length, karts: sorted }, null, 2));
  }

  if (url === "/raw") {
    return res.end(JSON.stringify({ messages: rawLog }, null, 2));
  }

  if (url === "/init") {
    return res.end(JSON.stringify({
      connectionTime,
      hasGrid: !!initHtml,
      kartsWithNames: Object.values(karts).filter(function(k){return k.driver;}).length,
      preview: initHtml.substring(0, 500),
    }, null, 2));
  }

  if (url === "/reconnect") {
    karts        = {};
    countdown_ms = 0;
    raceStarted  = false;
    initHtml     = "";
    comments     = [];
    if (apexWs) { try { apexWs.close(); } catch(e) {} }
    setTimeout(connectToApex, 500);
    return res.end(JSON.stringify({
      ok: true,
      message: "Reconnexion en cours — attendre 3s puis vérifier /status"
    }));
  }

  res.end(JSON.stringify({
    name: "Race Founders Proxy v3 — RKC",
    ourKart: OUR_KART_NUM,
    endpoints: {
      "/status":    "État proxy + nb karts avec noms",
      "/race":      "Classement complet avec noms",
      "/karts":     "Tous les karts bruts",
      "/raw":       "30 derniers messages",
      "/init":      "État du paquet initial HTML",
      "/reconnect": "Reset + reconnexion",
    }
  }, null, 2));
});

// WebSocket dashboard
const wss = new WebSocket.Server({ server });
wss.on("connection", function(ws) {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "update", data: buildState() }));
  ws.on("close", function() { clients.delete(ws); });
  ws.on("error", function() { clients.delete(ws); });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log("\n🏁 Race Founders Proxy v3");
  console.log("   Port: " + PORT + " | Kart: #" + OUR_KART_NUM);
  connectToApex();
});
