/**
 * Race Founders Proxy — RKC Live Timing v5
 * Mapping colonnes confirmé par analyse du raw :
 *   c2||NUM          → numéro kart affiché
 *   c4|dr|NOM        → nom équipe
 *   c4|drteam|NOM[t] → nom pilote en piste + temps roulage
 *   c6|in|VAL        → écart au leader
 *   c9|tn|VAL        → secteur 1
 *   c10|tn|VAL       → meilleur tour
 *   c12|to|VAL       → temps en piste (time on track)
 *   c12|in|VAL       → temps en piste (entrant stand)
 *   r[ID]|*|GAP|INT  → gap + intervalle
 *   r[ID]|#|NUM      → numéro kart
 *   dyn1|countdown|MS→ temps restant
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

let karts = {}, countdown_ms = 0, raceStarted = false;
let sessionTitle = "", trackName = "", lastUpdate = null;
let rawLog = [], connectionTime = null, comments = [];

function fmtMs(ms) {
  var s = Math.floor(Math.abs(ms)/1000);
  var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sc = s%60;
  return (ms<0?"-":"") + String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(sc).padStart(2,"0");
}

function ensureKart(id) {
  if (!karts[id]) karts[id] = {
    id:id, pos:99, kartNum:"", teamName:"", piloteName:"", piloteTime:"",
    gap:"", interval:"", lastLap:"", bestLap:"", laps:0, pits:0,
    status:"", onTrack:"", s1:"",
  };
  return karts[id];
}

function parseGridHtml(html) {
  var rowRe = /data-id="r(\d+)"\s+data-pos="(\d+)"[\s\S]*?<\/tr>/g;
  var match, count = 0;
  while ((match = rowRe.exec(html)) !== null) {
    var kartId = match[1], pos = parseInt(match[2]);
    if (kartId === "0") continue;
    var row = match[0];
    var kart = ensureKart(kartId);
    kart.pos = pos;
    var c4 = row.match(/data-id="r\d+c4"[^>]*>([^<]*)</);
    if (c4 && c4[1].trim()) kart.kartNum = c4[1].trim();
    var c5 = row.match(/data-id="r\d+c5"[^>]*>([^<]+)</);
    if (c5 && c5[1].trim()) kart.teamName = c5[1].trim();
    var c12 = row.match(/data-id="r\d+c12"[^>]*>([^<]*)</);
    if (c12 && c12[1].trim()) kart.bestLap = c12[1].trim();
    var c13 = row.match(/data-id="r\d+c13"[^>]*>([^<]*)</);
    if (c13 && c13[1].trim()) kart.lastLap = c13[1].trim();
    var c14 = row.match(/data-id="r\d+c14"[^>]*>([^<]*)</);
    if (c14 && c14[1].trim()) kart.pits = parseInt(c14[1].trim()) || 0;
    var c1cls = row.match(/data-id="r\d+c1"\s+class="([^"]+)"/);
    if (c1cls) kart.status = c1cls[1];
    count++;
  }
  console.log("[Grid] "+count+" karts depuis HTML");
}

function parseMessage(raw) {
  rawLog.push(raw.substring(0,300));
  if (rawLog.length > 30) rawLog.shift();

  var lines = raw.split("\n");
  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;
    if (line.startsWith("grid||"))   { parseGridHtml(line.substring(6)); return; }
    if (line.startsWith("title1||")) { sessionTitle = line.substring(8); return; }
    if (line.startsWith("title2||")) { sessionTitle += " — "+line.substring(8); return; }
    if (line.startsWith("track||"))  { trackName = line.substring(7); return; }
    if (line.startsWith("com||")) {
      var txt = line.substring(5).replace(/<[^>]+>/g," ").trim();
      if (txt) comments = txt.split("  ").filter(Boolean).slice(0,5);
      return;
    }
    if (line.includes("dyn1|countdown|")) {
      var cm = line.match(/dyn1\|countdown\|(\d+)/);
      if (cm) { countdown_ms = parseInt(cm[1]); raceStarted = true; }
    }
    // Parse tous les tokens r[ID]...
    var tokens = line.match(/r\d+[^\s]*/g) || [];
    tokens.forEach(function(t) { parseKartToken(t.trim()); });
  });
  lastUpdate = new Date().toISOString();
}

function parseKartToken(token) {
  if (!token || !token.startsWith("r")) return;

  // Format r[ID]|*|GAP|INTERVAL
  var mStar = token.match(/^r(\d+)\|\*\|(\d+)\|(\d+)$/);
  if (mStar) {
    var kStar = ensureKart(mStar[1]);
    var g = parseInt(mStar[2]);
    kStar.gap = g === 0 ? "Leader" : "+"+(g/1000).toFixed(3)+"s";
    kStar.interval = (parseInt(mStar[3])/1000).toFixed(3)+"s";
    return;
  }

  // Format r[ID]|#|NUM (numéro kart)
  var mHash = token.match(/^r(\d+)\|#\|(\d+)$/);
  if (mHash) {
    ensureKart(mHash[1]).kartNum = mHash[2];
    return;
  }

  // Format r[ID]|*i[N]|GAP (position)
  var mPos = token.match(/^r(\d+)\|\*i(\d+)\|(\d*)$/);
  if (mPos) {
    var kPos = ensureKart(mPos[1]);
    kPos.pos = parseInt(mPos[2]);
    if (mPos[3]) {
      var gp = parseInt(mPos[3]);
      kPos.gap = gp === 0 ? "Leader" : "+"+(gp/1000).toFixed(3)+"s";
    }
    return;
  }

  // Format r[ID]|*out
  if (token.match(/^r\d+\|\*out\|/)) {
    ensureKart(token.match(/^r(\d+)/)[1]).status = "out";
    return;
  }

  // Format standard r[ID]c[N]|type|value
  var m = token.match(/^r(\d+)(c\d+)\|([^|]*)\|(.*)$/);
  if (!m) return;
  var kartId = m[1], col = m[2], type = m[3], value = m[4].trim();
  var kart = ensureKart(kartId);

  switch(col) {
    case "c1": kart.status = type || kart.status; break;
    case "c2":
      // numéro kart affiché (type vide souvent)
      if (value) kart.kartNum = value;
      break;
    case "c4":
      if (type === "dr") {
        if (value) kart.teamName = value.trim();
      } else if (type === "drteam") {
        if (value) {
          // "NOUET Noah [0:49]" → nom + temps roulage
          var pm = value.match(/^(.*?)\s*\[(\d+:\d+)\]$/);
          if (pm) {
            kart.piloteName = pm[1].trim();
            kart.piloteTime = pm[2];
          } else {
            kart.piloteName = value.trim();
          }
        }
      } else {
        // numéro kart dans certains formats
        if (value) kart.kartNum = value;
      }
      break;
    case "c6":
      // écart au leader
      if (value) kart.gap = value;
      break;
    case "c8":
      // meilleur tour (parfois)
      if (value) kart.bestLap = value;
      break;
    case "c9":
      // secteur 1
      if (value) kart.s1 = value;
      break;
    case "c10":
      // meilleur tour
      if (value) kart.bestLap = value;
      break;
    case "c12":
      if (type === "to" || type === "in") {
        if (value) kart.onTrack = value;
      }
      break;
    case "c13":
      if (value && (type === "tn" || type === "ti")) kart.lastLap = value;
      break;
    case "c14":
      if (value) kart.pits = parseInt(value) || kart.pits;
      break;
  }
}

function buildState() {
  var entries = Object.values(karts)
    .filter(function(k) { return k.teamName || k.piloteName || k.kartNum; })
    .sort(function(a,b) { return a.pos - b.pos; })
    .map(function(k) {
      return {
        pos:        k.pos,
        kart:       k.kartNum || k.id,
        team:       k.teamName || "",
        driver:     k.piloteName || k.teamName || ("Kart "+(k.kartNum||k.id)),
        driverTime: k.piloteTime || "",
        lastLap:    k.lastLap || "",
        bestLap:    k.bestLap || "",
        laps:       k.laps || 0,
        gap:        k.gap || "",
        interval:   k.interval || "",
        pits:       k.pits || 0,
        status:     k.status || "",
        onTrack:    k.onTrack || "",
        s1:         k.s1 || "",
      };
    });

  var ourTeam = entries.find(function(e) {
    return String(e.kart) === OUR_KART_NUM;
  }) || null;

  return {
    connected:     true,
    raceActive:    raceStarted,
    sessionTitle:  sessionTitle,
    trackName:     trackName,
    timeRemaining: countdown_ms > 0 ? fmtMs(countdown_ms) : "—",
    countdown_ms:  countdown_ms,
    lastUpdate:    lastUpdate,
    connectionTime:connectionTime,
    totalKarts:    entries.length,
    ourKart:       OUR_KART_NUM,
    comments:      comments,
    entries:       entries,
    ourTeam:       ourTeam,
  };
}

var apexWs = null, reconnectTimer = null;
var clients = new Set();

function broadcast(msg) {
  var json = JSON.stringify(msg);
  clients.forEach(function(ws) { if (ws.readyState === WebSocket.OPEN) ws.send(json); });
}

function connectToApex() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionTime = new Date().toISOString();
  console.log("[Apex] Connexion...");
  try { apexWs = new WebSocket(APEX_WS_URL, { headers: APEX_HEADERS }); }
  catch(e) { reconnectTimer = setTimeout(connectToApex, 8000); return; }
  apexWs.on("open",    function() { console.log("[Apex] Connecte ! Kart: "+OUR_KART_NUM); });
  apexWs.on("message", function(data) { parseMessage(data.toString()); broadcast({type:"update",data:buildState()}); });
  apexWs.on("close",   function() { reconnectTimer = setTimeout(connectToApex,5000); broadcast({type:"disconnected"}); });
  apexWs.on("error",   function(e) { console.error("[Apex]",e.message); });
}

var server = http.createServer(function(req,res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json; charset=utf-8");
  var url = (req.url||"/").split("?")[0];

  if (url==="/status") return res.end(JSON.stringify({
    ok:true, apexConnected:apexWs&&apexWs.readyState===WebSocket.OPEN,
    ourKart:OUR_KART_NUM, raceActive:raceStarted, sessionTitle:sessionTitle,
    trackName:trackName, timeRemaining:fmtMs(countdown_ms),
    kartsTracked:Object.keys(karts).length,
    kartsWithNames:Object.values(karts).filter(function(k){return k.teamName||k.piloteName;}).length,
    lastUpdate:lastUpdate, connectionTime:connectionTime, dashboardClients:clients.size,
  },null,2));

  if (url==="/race")      return res.end(JSON.stringify(buildState(),null,2));
  if (url==="/raw")       return res.end(JSON.stringify({messages:rawLog},null,2));
  if (url==="/karts")     return res.end(JSON.stringify(Object.values(karts).sort(function(a,b){return a.pos-b.pos;}),null,2));
  if (url==="/reconnect") {
    karts={}; countdown_ms=0; raceStarted=false; comments=[];
    if (apexWs) { try{apexWs.close();}catch(e){} }
    setTimeout(connectToApex,500);
    return res.end(JSON.stringify({ok:true,message:"Reconnexion en cours — attendre 3s"}));
  }
  res.end(JSON.stringify({name:"Race Founders Proxy v5",ourKart:OUR_KART_NUM,
    endpoints:{"/status":"Etat","/race":"Classement","/raw":"Messages bruts","/karts":"Karts","/reconnect":"Reset"}}
  ,null,2));
});

var wss = new WebSocket.Server({server});
wss.on("connection",function(ws){
  clients.add(ws);
  ws.send(JSON.stringify({type:"update",data:buildState()}));
  ws.on("close",function(){clients.delete(ws);});
  ws.on("error",function(){clients.delete(ws);});
});

var PORT = process.env.PORT||3001;
server.listen(PORT,function(){
  console.log("Race Founders Proxy v5 | Port:"+PORT+" | Kart:#"+OUR_KART_NUM);
  connectToApex();
});
