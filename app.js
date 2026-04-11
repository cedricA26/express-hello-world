const http = require("http");
const WebSocket = require("ws");

const APEX_WS_URL = "wss://www.apex-timing.com:7913/";
const OUR_KART_NUM = "42";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Origin": "https://www.apex-timing.com",
  "Referer": "https://www.apex-timing.com/live-timing/rkc/",
  "Host": "www.apex-timing.com:7913",
};

let karts = {}, countdown_ms = 0, raceStarted = false, lastUpdate = null, rawLog = [];

function fmt_ms(ms){const s=Math.floor(ms/1000);return`${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;}
function fmt_lap(v){const n=parseFloat(v);if(isNaN(n))return v;if(n>=60){return`${Math.floor(n/60)}:${String((n%60).toFixed(3)).padStart(6,"0")}`;}return v;}
function ensureKart(id){if(!karts[id])karts[id]={id,pos:99,kartNum:id,driver:"",gap:"",lastLap:"",bestLap:"",laps:0,pits:0,status:"on_track"};return karts[id];}

function parseMessage(raw){
  rawLog.push(raw.substring(0,200));if(rawLog.length>20)rawLog.shift();
  if(raw.startsWith("dyn1|countdown|")){const ms=parseInt(raw.split("|")[2]);if(!isNaN(ms)){countdown_ms=ms;raceStarted=true;}return;}
  raw.trim().split(" ").forEach(part=>{
    part=part.trim();if(!part||!part.startsWith("r"))return;
    const m=part.match(/^r(\d+)(c\d+)?\|([^|]+)\|(.*)$/);if(!m)return;
    const[,kartId,col,type,value]=m;const kart=ensureKart(kartId);
    if(type.startsWith("*i")){kart.pos=parseInt(type.substring(2))||kart.pos;if(value){const g=parseInt(value);kart.gap=g>0?"+"+(g/1000).toFixed(3)+"s":"Leader";}return;}
    switch(col){
      case"c2":kart.kartNum=value||kart.kartNum;break;
      case"c3":kart.driver=value||kart.driver;break;
      case"c6":if(value)kart.lastLap=fmt_lap(value);break;
      case"c8":if(value)kart.bestLap=fmt_lap(value);break;
      case"c9":if(type==="tn"&&value)kart.laps=parseInt(value)||kart.laps;break;
      case"c10":kart.pits=parseInt(value)||kart.pits;break;
    }
  });
  lastUpdate=new Date().toISOString();
}

function buildState(){
  const entries=Object.values(karts).sort((a,b)=>a.pos-b.pos).map(k=>({pos:k.pos,kart:k.kartNum||k.id,driver:k.driver||`Kart ${k.kartNum||k.id}`,lastLap:k.lastLap,bestLap:k.bestLap,laps:k.laps,gap:k.gap,pits:k.pits}));
  return{connected:true,raceActive:raceStarted,timeRemaining:fmt_ms(countdown_ms),countdown_ms,lastUpdate,totalKarts:entries.length,entries,ourTeam:entries.find(e=>String(e.kart)===OUR_KART_NUM||String(e.kart).endsWith(OUR_KART_NUM))||null};
}

const clients=new Set();
function broadcast(msg){const json=JSON.stringify(msg);clients.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(json);});}

let apexWs=null;
function connectToApex(){
  try{apexWs=new WebSocket(APEX_WS_URL,{headers:HEADERS});}catch(e){setTimeout(connectToApex,8000);return;}
  apexWs.on("open",()=>console.log("Connected to Apex!"));
  apexWs.on("message",data=>{parseMessage(data.toString());broadcast({type:"update",data:buildState()});});
  apexWs.on("close",()=>{console.log("Reconnecting...");setTimeout(connectToApex,5000);});
  apexWs.on("error",err=>console.error("Error:",err.message));
}

const server=http.createServer((req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json");
  if(req.url==="/status")return res.end(JSON.stringify({ok:true,apexConnected:apexWs?.readyState===1,kartsTracked:Object.keys(karts).length,timeRemaining:fmt_ms(countdown_ms),lastUpdate}));
  if(req.url==="/race")return res.end(JSON.stringify(buildState()));
  if(req.url==="/raw")return res.end(JSON.stringify({messages:rawLog}));
  res.end(JSON.stringify({name:"Race Founders Proxy",endpoints:["/status","/race","/raw"]}));
});

const wss=new WebSocket.Server({server});
wss.on("connection",ws=>{clients.add(ws);ws.send(JSON.stringify({type:"update",data:buildState()}));ws.on("close",()=>clients.delete(ws));});

const PORT=process.env.PORT||3001;
server.listen(PORT,()=>{console.log(`Proxy on port ${PORT}`);connectToApex();});
