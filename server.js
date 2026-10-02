'use strict';
// Weltenbummler – Server: liefert das Spiel aus und leitet die Spiele (WebSocket unter /ws).
// Die Koordinaten der Orte bleiben hier auf dem Server; der Browser bekommt nur die
// Bildnummer und erfährt die Lösung erst nach dem Raten. Allein spielen ist einfach
// ein privater Raum mit nur einem Spieler.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
const { WebSocketServer } = require('ws');
const zugang = require('./zugang')({ titel:'Weltenbummler' });
const olymp = require('./olymp')({ spiel:'weltenbummler' });

const PORT = Number(process.env.PORT) || 10200;
const MAX_RAEUME = 300;
const MAX_SPIELER = 12;
const AUTO_WEITER = 60_000;       // ms nach der Auflösung, dann geht es im Party-Modus von selbst weiter
const PLATZ_HALTEN = 90_000;      // so lange bleibt der Platz nach einem Verbindungsabbruch frei
const ZEITEN = [0, 30, 60, 90, 120, 180, 300];
const TYPEN = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8',
  '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.png':'image/png'
};
const DATEIEN = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/spiel.js', 'spiel.js'], ['/karte.js', 'karte.js'],
  ['/spiel.css', 'spiel.css'], ['/icon.svg', 'icon.svg']
]);

/* ---------- Welt und Strecken ---------- */
const welt = JSON.parse(fs.readFileSync(path.join(__dirname, 'daten', 'welt.json'), 'utf8'));

function peilung(a, b){
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
// Jede Strecke ist ein kleiner Weg-Graph aus Panoramen (siehe werkzeug/strecken-bauen.js).
// Gewertet wird gegen den Startpunkt.
const KNOTEN = new Map();   // Bild-ID -> Adresse bei Wikimedia (für den Zwischenspeicher)
const ORTE = JSON.parse(fs.readFileSync(path.join(__dirname, 'daten', 'strecken.json'), 'utf8'))
  .filter(s => fs.existsSync(path.join(__dirname, 'panos', s.knoten[s.start].id + '.jpg')))
  .map(s => {
    const k = s.knoten[s.start];
    const korr = s.korrektur || 0;
    const nachbarn = s.knoten.map(() => []);
    for (const [a, b] of s.kanten){
      nachbarn[a].push([b, Math.round(peilung(s.knoten[a], s.knoten[b]))]);
      nachbarn[b].push([a, Math.round(peilung(s.knoten[b], s.knoten[a]))]);
    }
    for (const n of s.knoten) KNOTEN.set(n.id, n.bild);
    const urheber = [...new Set(s.knoten.map(n => n.urheber))];
    return {
      id:s.id, lat:k.lat, lon:k.lon, lizenz:k.lizenz, lizenzUrl:k.lizenzUrl,
      urheber:urheber.slice(0, 3).join(', ') + (urheber.length > 3 ? ' u. a.' : ''),
      seite:'https://commons.wikimedia.org/wiki/' + encodeURIComponent(s.kategorie.replace(/ /g, '_')).replace(/%3A/g, ':'),
      // Was der Browser bekommt: Bild-IDs, Blickrichtungen und Wege – aber keine Koordinaten
      graph:{ start:s.start, knoten:s.knoten.map((n, i) => ({ id:n.id, h:Math.round(((n.h + korr) % 360) * 10) / 10, n:nachbarn[i] })) }
    };
  });

function imRing(r, x, y){
  let drin = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2){
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) drin = !drin;
  }
  return drin;
}
// Land zu einem Punkt: erst exakt, sonst das Land mit dem nächsten Grenzpunkt (Küsten sind vereinfacht)
function landVon(lat, lon){
  for (const l of welt.laender){
    let drin = false;
    for (const r of l.r) if (imRing(r, lon, lat)) drin = !drin;
    if (drin) return l;
  }
  let best = null, min = Infinity;
  for (const l of welt.laender) for (const r of l.r) for (let i = 0; i < r.length; i += 2){
    const d = (r[i] - lon) ** 2 + (r[i + 1] - lat) ** 2;
    if (d < min){ min = d; best = l; }
  }
  return min < 1 ? best : null;
}
for (const o of ORTE){
  const l = landVon(o.lat, o.lon);
  o.land = l ? l.n : 'Ozean';
  o.kontinent = l ? l.k : '';
}

function km(a, b){
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Regionen: die ganze Welt und jeder Kontinent mit genug Orten.
// Die Punkteskala hängt von der Größe der Region ab (Welt: 5000 · e^(−km/1493)).
const REGIONEN = [{ id:'welt', name:'Ganze Welt', orte:ORTE, skala:1492.7 }];
{
  const nachK = new Map();
  for (const o of ORTE) if (o.kontinent) (nachK.get(o.kontinent) || nachK.set(o.kontinent, []).get(o.kontinent)).push(o);
  const reihenfolge = ['Europa', 'Asien', 'Nordamerika', 'Südamerika', 'Afrika', 'Ozeanien'];
  for (const k of reihenfolge){
    const liste = nachK.get(k) || [];
    if (liste.length < 8) continue;
    let maxD = 0;
    for (let i = 0; i < liste.length; i++) for (let j = i + 1; j < liste.length; j++) maxD = Math.max(maxD, km(liste[i], liste[j]));
    REGIONEN.push({ id:k.toLowerCase(), name:k, orte:liste, skala:Math.max(150, maxD / 10) });
  }
  const dach = ORTE.filter(o => ['Deutschland', 'Österreich', 'Schweiz', 'Liechtenstein'].includes(o.land));
  if (dach.length >= 8) REGIONEN.push({ id:'dach', name:'Deutschland, Österreich, Schweiz', orte:dach, skala:90 });
}
const regionVon = id => REGIONEN.find(r => r.id === id) || REGIONEN[0];
const punkteFuer = (d, skala) => (d < 0.05 ? 5000 : Math.round(5000 * Math.exp(-d / skala)));
console.log(`${ORTE.length} Orte, Regionen: ${REGIONEN.map(r => `${r.name} (${r.orte.length})`).join(', ')}`);

/* ---------- HTTP ---------- */
const esc = t => String(t).replace(/[&<>"]/g, z => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[z]));
function senden(res, datei, cache){
  const voll = path.join(__dirname, datei);
  fs.stat(voll, (err, st) => {
    if (err || !st.isFile()){ res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type':TYPEN[path.extname(voll)] || 'application/octet-stream', 'Content-Length':st.size, 'Cache-Control':cache });
    fs.createReadStream(voll).pipe(res);
  });
}
function bildnachweise(res){
  const zeilen = ORTE.map((o, i) => `<li><a href="${esc(o.seite)}" rel="noopener" target="_blank">Strecke ${i + 1}</a> von ${esc(o.urheber)}, `
    + (o.lizenzUrl ? `<a href="${esc(o.lizenzUrl)}" rel="noopener license" target="_blank">${esc(o.lizenz)}</a>` : esc(o.lizenz)) + '</li>').join('\n');
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache' });
  res.end(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Bildnachweise – Weltenbummler</title>
<style>:root{--bg:#f4f6f8;--text:#16202c;--leise:#5a6878;--a:#1553a8}
@media (prefers-color-scheme: dark){:root{--bg:#0e141c;--text:#eef2f6;--leise:#9aa8b8;--a:#7fb0ff}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,sans-serif}
main{max-width:760px;margin:auto}a{color:var(--a)}p,li{color:var(--leise)}li{margin:2px 0}</style></head><body><main>
<h1>Bildnachweise</h1>
<p>Die Panoramen stammen von <a href="https://commons.wikimedia.org" rel="noopener" target="_blank">Wikimedia Commons</a>
(ursprünglich von Mapillary) und stehen unter freien Lizenzen. Eine Strecke besteht aus den Bildern einer Aufnahmefahrt;
der Link führt zur Sammlung aller Bilder dieser Fahrt. Für das Spiel wurden sie verkleinert.
Die Reihenfolge hier verrät nicht, welche Strecke im Spiel gerade dran ist.</p>
<p>Karte: <a href="https://openfreemap.org" rel="noopener" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" rel="noopener" target="_blank">OpenMapTiles</a>, Daten © <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a>-Mitwirkende (ODbL). Beschriftungen für das Spiel vereinheitlicht (deutsche bzw. lateinische Namen).
Ländergrenzen für die Auswertung: <a href="https://www.naturalearthdata.com" rel="noopener" target="_blank">Natural Earth</a> (gemeinfrei).
Kartenanzeige: MapLibre GL JS (BSD-Lizenz).
3D-Anzeige: three.js (MIT-Lizenz). Schrift: Barlow Semi Condensed (SIL Open Font License).</p>
<ol>${zeilen}</ol>
<p><a href="/">Zurück zum Spiel</a> · <a href="/datenschutz">Datenschutz</a></p>
</main></body></html>`);
}

/* ---------- Panoramen: Startbilder liegen bei, der Rest wird einmal geholt und gespeichert ---------- */
// Die Spieler laden alles von hier; nur dieser Server spricht mit Wikimedia.
const ZWISCHEN = process.env.CACHE_DIR || path.join(os.tmpdir(), 'weltenbummler-panos');
const MAX_ZWISCHEN = Number(process.env.CACHE_MAX) || 2500;   // Dateien, danach fliegen die ältesten raus
const UA = { 'User-Agent':'Weltenbummler/1.0 (privates Familien-Spiel; +https://github.com/taddelcoder-svg/taddelgeo)' };
fs.mkdirSync(ZWISCHEN, { recursive:true });
const unterwegs = new Map();   // id -> Promise (gleiche Anfragen nur einmal holen)
const warteschlange = [];
let laufend = 0;
function naechster(){
  while (laufend < 3 && warteschlange.length){ laufend++; warteschlange.shift()(); }
}
function holen(id){
  if (unterwegs.has(id)) return unterwegs.get(id);
  const ziel = path.join(ZWISCHEN, id + '.jpg');
  const p = new Promise((ok, fehler) => warteschlange.push(async () => {
    try {
      let r;
      for (let v = 0; v < 3; v++){
        r = await fetch(KNOTEN.get(id), { headers:UA, signal:AbortSignal.timeout(30_000) });
        if (r.status !== 429 && r.status < 500) break;
        await new Promise(w => setTimeout(w, 1500 * (v + 1)));
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const roh = Buffer.from(await r.arrayBuffer());
      const bild = await sharp(roh).resize(2560, 1280, { fit:'fill' }).jpeg({ quality:72, mozjpeg:true }).toBuffer();
      await fs.promises.writeFile(ziel + '.tmp', bild);
      await fs.promises.rename(ziel + '.tmp', ziel);
      ok(ziel);
      aufraeumenZwischen();
    } catch (e){ fehler(e); }
    finally { laufend--; unterwegs.delete(id); naechster(); }
  }));
  unterwegs.set(id, p);
  naechster();
  return p;
}
let aufraeumTimer = null;
function aufraeumenZwischen(){
  if (aufraeumTimer) return;
  aufraeumTimer = setTimeout(async () => {
    aufraeumTimer = null;
    try {
      const dateien = (await fs.promises.readdir(ZWISCHEN)).filter(f => f.endsWith('.jpg'));
      if (dateien.length <= MAX_ZWISCHEN) return;
      const mitZeit = await Promise.all(dateien.map(async f => ({ f, t:(await fs.promises.stat(path.join(ZWISCHEN, f))).atimeMs })));
      mitZeit.sort((a, b) => a.t - b.t);
      for (const { f } of mitZeit.slice(0, dateien.length - MAX_ZWISCHEN)) await fs.promises.unlink(path.join(ZWISCHEN, f)).catch(() => {});
    } catch {}
  }, 10_000);
}
function dateiSenden(res, voll){
  fs.stat(voll, (err, st) => {
    if (err){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type':'image/jpeg', 'Content-Length':st.size, 'Cache-Control':'public, max-age=2592000, immutable' });
    fs.createReadStream(voll).pipe(res);
  });
}
function panoSenden(res, id){
  const beiliegend = path.join(__dirname, 'panos', id + '.jpg');
  if (fs.existsSync(beiliegend)) return dateiSenden(res, beiliegend);
  if (!KNOTEN.has(id)){ res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
  const gespeichert = path.join(ZWISCHEN, id + '.jpg');
  if (fs.existsSync(gespeichert)) return dateiSenden(res, gespeichert);
  holen(id).then(v => dateiSenden(res, v), e => {
    console.warn('Panorama nicht geladen:', id, e.message);
    res.writeHead(502, { 'Content-Type':'text/plain; charset=utf-8' }); res.end('Panorama gerade nicht verfügbar');
  });
}
/* ---------- Vektorkarte von OpenFreeMap, über diesen Server ---------- */
// Kacheln, Schriften, Symbole und Reliefbilder werden bei OpenFreeMap geholt und hier
// zwischengespeichert; der Browser der Spieler spricht nur mit diesem Server.
// Holen nur, was gerade jemand ansieht (kein Vorladen).
const OFM = 'https://tiles.openfreemap.org';
const KARTE_CACHE = path.join(ZWISCHEN, 'vkarte');
const KACHEL_ALTER = 7 * 24 * 3600 * 1000;
let kachelVorlage = null, vorlageZeit = 0;
// Die Kachel-Adresse enthält einen Datenstand; er steht im TileJSON und wird täglich neu gelesen
async function kachelAdresse(z, x, y){
  if (!kachelVorlage || Date.now() - vorlageZeit > 24 * 3600 * 1000){
    const r = await fetch(`${OFM}/planet`, { headers:UA, signal:AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error('TileJSON HTTP ' + r.status);
    kachelVorlage = (await r.json()).tiles[0];
    vorlageZeit = Date.now();
  }
  return kachelVorlage.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
const karteUnterwegs = new Map();
let karteLaufend = 0;
const karteSchlange = [];
function karteNaechste(){
  while (karteLaufend < 4 && karteSchlange.length){ karteLaufend++; karteSchlange.shift()(); }
}
function karteHolen(schluessel, adresse){
  if (karteUnterwegs.has(schluessel)) return karteUnterwegs.get(schluessel);
  const ziel = path.join(KARTE_CACHE, schluessel);
  const p = new Promise((ok, fehler) => karteSchlange.push(async () => {
    try {
      const url = typeof adresse === 'function' ? await adresse() : adresse;
      const r = await fetch(url, { headers:UA, signal:AbortSignal.timeout(20_000) });
      if (r.status === 204 || r.status === 404){ ok(Buffer.alloc(0)); return; }   // leere Kachel (z. B. offenes Meer)
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // gzip-komprimiert speichern, dann kann es direkt so ausgeliefert werden
      const daten = zlib.gzipSync(Buffer.from(await r.arrayBuffer()));
      await fs.promises.mkdir(path.dirname(ziel), { recursive:true });
      await fs.promises.writeFile(ziel + '.tmp', daten);
      await fs.promises.rename(ziel + '.tmp', ziel);
      ok(daten);
    } catch (e){ fehler(e); }
    finally { karteLaufend--; karteUnterwegs.delete(schluessel); karteNaechste(); }
  }));
  karteUnterwegs.set(schluessel, p);
  karteNaechste();
  return p;
}
// Beim Start die Weltansicht (Zoom 0–3, 85 Kacheln) einmal holen, damit die erste Karte schnell da ist
setTimeout(async () => {
  for (let z = 0; z <= 3; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++){
    const schluessel = `tiles/${z}/${x}/${y}.pbf.gz`;
    if (fs.existsSync(path.join(KARTE_CACHE, schluessel))) continue;
    await karteHolen(schluessel, () => kachelAdresse(z, x, y)).catch(() => {});
  }
}, 2000).unref();
const KARTEN_TYPEN = { pbf:'application/x-protobuf', png:'image/png', json:'application/json' };
function karteSenden(req, res, pfad){
  let m, schluessel, adresse, alter = Infinity;
  if ((m = /^tiles\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.pbf$/.exec(pfad))){
    const [z, x, y] = [+m[1], +m[2], +m[3]];
    if (z > 14 || x >= 2 ** z || y >= 2 ** z) return nichtDa();
    schluessel = `tiles/${z}/${x}/${y}.pbf.gz`; adresse = () => kachelAdresse(z, x, y); alter = KACHEL_ALTER;
  } else if ((m = /^ne2sr\/(\d)\/(\d{1,2})\/(\d{1,2})\.png$/.exec(pfad))){
    const [z, x, y] = [+m[1], +m[2], +m[3]];
    if (z > 6 || x >= 2 ** z || y >= 2 ** z) return nichtDa();
    schluessel = `ne2sr/${z}/${x}/${y}.png.gz`; adresse = `${OFM}/natural_earth/ne2sr/${z}/${x}/${y}.png`;
  } else if ((m = /^fonts\/(Noto%20Sans%20(?:Regular|Bold|Italic))\/(\d{1,5}-\d{1,5})\.pbf$/.exec(pfad))){
    schluessel = `fonts/${decodeURIComponent(m[1])}/${m[2]}.pbf.gz`; adresse = `${OFM}/fonts/${m[1]}/${m[2]}.pbf`;
  } else if ((m = /^sprites\/ofm(@2x)?\.(json|png)$/.exec(pfad))){
    schluessel = `sprites/ofm${m[1] || ''}.${m[2]}.gz`; adresse = `${OFM}/sprites/ofm_f384/ofm${m[1] || ''}.${m[2]}`;
  } else return nichtDa();
  const typ = KARTEN_TYPEN[/\.(pbf|png|json)\.gz$/.exec(schluessel)[1]];
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const schicken = daten => {
    if (!daten.length){ res.writeHead(204, { 'Cache-Control':'public, max-age=86400' }); return res.end(); }
    const body = gz ? daten : zlib.gunzipSync(daten);
    res.writeHead(200, { 'Content-Type':typ, 'Content-Length':body.length, 'Cache-Control':'public, max-age=604800', 'Vary':'Accept-Encoding', ...(gz ? { 'Content-Encoding':'gzip' } : {}) });
    res.end(body);
  };
  const ziel = path.join(KARTE_CACHE, schluessel);
  fs.stat(ziel, (err, st) => {
    if (!err && Date.now() - st.mtimeMs < alter) return fs.readFile(ziel, (e, d) => (e ? holen() : schicken(d)));
    holen(err);
  });
  function holen(alteDaFehler){
    karteHolen(schluessel, adresse).then(schicken, e => {
      // Wenn OpenFreeMap nicht antwortet, lieber eine ältere Kopie zeigen als gar nichts
      if (alteDaFehler === null) return fs.readFile(ziel, (e2, d) => (e2 ? fehlt(e) : schicken(d)));
      fehlt(e);
    });
  }
  function fehlt(e){
    console.warn('Karte nicht geladen:', pfad, e && e.message);
    res.writeHead(502, { 'Content-Type':'text/plain; charset=utf-8' }); res.end('Karte gerade nicht verfügbar');
  }
  function nichtDa(){ res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); res.end('Nicht gefunden'); }
}

// Nächste Schritte schon mal holen, damit das Laufen flüssig ist
function vorladen(ort, abIndex, tiefe = 2){
  const g = ort.graph, gesehen = new Set([abIndex]);
  let rand = [abIndex];
  for (let t = 0; t < tiefe; t++){
    const neu = [];
    for (const i of rand) for (const [n] of g.knoten[i].n) if (!gesehen.has(n)){ gesehen.add(n); neu.push(n); }
    rand = neu;
  }
  for (const i of gesehen){
    const id = g.knoten[i].id;
    if (!fs.existsSync(path.join(__dirname, 'panos', id + '.jpg')) && !fs.existsSync(path.join(ZWISCHEN, id + '.jpg'))) holen(id).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname.startsWith('/datenschutz')) return senden(res, 'datenschutz.html', 'no-cache');
  if (req.method === 'GET' && url.pathname === '/healthz'){
    res.writeHead(200, { 'Content-Type':'application/json' }); return res.end('{"ok":true}');
  }
  if (zugang.pruefen(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD'){ res.writeHead(405); return res.end(); }
  const pano = /^\/panos\/([a-f0-9]{12})\.jpg$/.exec(url.pathname);
  if (pano) return panoSenden(res, pano[1]);
  if (url.pathname.startsWith('/vkarte/')) return karteSenden(req, res, url.pathname.slice(8));
  if (url.pathname === '/kartenstil.json') return senden(res, path.join('daten', 'kartenstil.json'), 'public, max-age=3600');
  const vendor = /^\/vendor\/([\w-]+(?:\.[\w-]+)*\.(js|css|woff2|txt))$/.exec(url.pathname);
  if (vendor) return senden(res, path.join('vendor', vendor[1]), 'public, max-age=604800');
  if (url.pathname === '/bildnachweise') return bildnachweise(res);
  if (DATEIEN.has(url.pathname)) return senden(res, DATEIEN.get(url.pathname), 'no-cache');
  res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' });
  res.end('Nicht gefunden');
});

/* ---------- Räume ---------- */
const RAUM_ZEICHEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const raeume = new Map();
const olympRaeume = new Map();   // Olympiade: "lauf:gruppe" -> Raum
const wss = new WebSocketServer({ server, path:'/ws', maxPayload:4096, verifyClient:({ req }) => zugang.hatZugang(req) });

function sende(ws, m){ if (ws && ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
function anAlle(raum, m){ const t = JSON.stringify(m); for (const s of raum.spieler.values()) sende(s.ws, t); }
const nameOk = n => String(n || '').replace(/[\u0000-\u001f\u007f<>&"]/g, '').trim().slice(0, 16) || 'Gast';
function neuerCode(){
  for (;;){
    let c = '';
    for (let i = 0; i < 4; i++) c += RAUM_ZEICHEN[crypto.randomInt(RAUM_ZEICHEN.length)];
    if (!raeume.has(c)) return c;
  }
}
function einstellungenPruefen(e, alt){
  e = e || {}; alt = alt || { runden:5, zeit:0, region:'welt', bewegen:true };
  const runden = Number.isInteger(e.runden) && e.runden >= 1 && e.runden <= 10 ? e.runden : alt.runden;
  const zeit = ZEITEN.includes(e.zeit) ? e.zeit : alt.zeit;
  const region = typeof e.region === 'string' && REGIONEN.some(r => r.id === e.region) ? e.region : alt.region;
  const bewegen = typeof e.bewegen === 'boolean' ? e.bewegen : alt.bewegen !== false;
  return { runden, zeit, region, bewegen };
}

function raumSenden(raum){
  const r = regionVon(raum.einst.region);
  const m = {
    t:'raum', code:raum.code, privat:raum.privat, host:raum.host, phase:raum.phase, einst:raum.einst,
    runde:raum.runde, regionName:r.name,
    regionen:REGIONEN.map(x => ({ id:x.id, name:x.name, anzahl:x.orte.length })),
    spieler:[...raum.spieler.values()].map(s => ({ id:s.id, name:s.name, punkte:s.punkte, geraten:!!s.tipp, weg:!!s.weg })),
    olymp:raum.olymp ? olympInfo(raum) : null
  };
  for (const s of raum.spieler.values()) sende(s.ws, { ...m, du:s.id });
}

function orteWaehlen(raum){
  const r = regionVon(raum.einst.region);
  let frei = r.orte.filter(o => !raum.gesehen.has(o.id));
  if (frei.length < raum.einst.runden){ raum.gesehen.clear(); frei = r.orte.slice(); }
  const aus = [];
  while (aus.length < raum.einst.runden && frei.length){
    const o = frei.splice(crypto.randomInt(frei.length), 1)[0];
    // Nicht zweimal dieselbe Gegend in einem Spiel
    if (aus.some(x => km(x, o) < 300) && frei.length > raum.einst.runden) continue;
    aus.push(o);
  }
  for (const o of aus) raum.gesehen.add(o.id);
  return aus;
}

// Ohne Bewegen bekommt der Browser nur das Startbild
function rundenGraph(raum, o){
  if (raum.einst.bewegen) return o.graph;
  const k = o.graph.knoten[o.graph.start];
  return { start:0, knoten:[{ id:k.id, h:k.h, n:[] }] };
}

function spielStarten(raum){
  if (raum.olymp){ raum.olymp.gestartet = true; clearTimeout(raum.olymp.startUhr); raum.olymp.startUhr = null; raum.olymp.startBis = 0; }
  raum.orte = orteWaehlen(raum);
  raum.einst.runden = raum.orte.length;
  raum.verlauf = [];
  for (const s of raum.spieler.values()) s.punkte = 0;
  raum.runde = 0;
  rundeStarten(raum);
}

function rundeStarten(raum){
  clearTimeout(raum.timer);
  raum.phase = 'runde';
  raum.runde++;
  for (const s of raum.spieler.values()) s.tipp = null;
  const o = raum.orte[raum.runde - 1];
  const zeit = raum.einst.zeit * 1000;
  raum.ende = zeit ? Date.now() + zeit + 1500 : 0;   // 1,5 s Puffer fürs Laden
  if (zeit) raum.timer = setTimeout(() => rundeAufloesen(raum), zeit + 1500);
  raumSenden(raum);
  vorladen(o, o.graph.start, raum.einst.bewegen ? 2 : 0);
  anAlle(raum, { t:'runde', nr:raum.runde, von:raum.einst.runden, graph:rundenGraph(raum, o), rest:zeit ? zeit + 1500 : 0, blick:crypto.randomInt(360) });
}

function rundeAufloesen(raum){
  if (raum.phase !== 'runde') return;
  clearTimeout(raum.timer);
  const o = raum.orte[raum.runde - 1];
  const r = regionVon(raum.einst.region);
  const tipps = [];
  for (const s of raum.spieler.values()){
    let d = null, p = 0, land = null;
    if (s.tipp){
      d = km(s.tipp, o);
      p = punkteFuer(d, r.skala);
      const l = landVon(s.tipp.lat, s.tipp.lon);
      land = l ? l.n : null;
    }
    s.punkte += p;
    tipps.push({ id:s.id, name:s.name, lat:s.tipp ? s.tipp.lat : null, lon:s.tipp ? s.tipp.lon : null, km:d, punkte:p, gesamt:s.punkte, land, richtigesLand:!!land && land === o.land });
  }
  tipps.sort((a, b) => b.punkte - a.punkte);
  const ziel = { lat:o.lat, lon:o.lon, land:o.land, urheber:o.urheber, lizenz:o.lizenz, lizenzUrl:o.lizenzUrl, seite:o.seite };
  raum.verlauf.push({ ziel, tipps });
  raum.phase = raum.runde >= raum.einst.runden ? 'ende' : 'aufloesung';
  raumSenden(raum);
  anAlle(raum, { t:'aufloesung', nr:raum.runde, von:raum.einst.runden, ziel, tipps, letzte:raum.phase === 'ende' });
  if (raum.phase === 'ende'){
    const rangliste = [...raum.spieler.values()].map(s => ({ id:s.id, name:s.name, punkte:s.punkte })).sort((a, b) => b.punkte - a.punkte);
    anAlle(raum, { t:'ende', rangliste, verlauf:raum.verlauf, max:5000 * raum.einst.runden });
    olympMelden(raum);
  } else if (!raum.privat){
    raum.timer = setTimeout(() => { if (raum.phase === 'aufloesung') rundeStarten(raum); }, AUTO_WEITER);
  }
}

function allePruefen(raum){
  if (raum.phase !== 'runde') return;
  const aktiv = [...raum.spieler.values()].filter(s => !s.weg);
  if (aktiv.length && aktiv.every(s => s.tipp)) rundeAufloesen(raum);
}

function verlassen(ws, sofort){
  const raum = ws.raum;
  if (!raum) return;
  ws.raum = null;
  const s = raum.spieler.get(ws.id);
  if (!s || s.ws !== ws) return;
  if (sofort || raum.phase === 'lobby'){
    raum.spieler.delete(ws.id);
  } else {
    s.weg = true; s.ws = null;
    s.wegTimer = setTimeout(() => { if (s.weg){ raum.spieler.delete(s.id); aufraeumen(raum); } }, PLATZ_HALTEN);
  }
  aufraeumen(raum);
}
function aufraeumen(raum){
  const aktiv = [...raum.spieler.values()].filter(s => !s.weg);
  if (!aktiv.length){
    if (!raum.spieler.size){ clearTimeout(raum.timer); raeume.delete(raum.code); }
    return;
  }
  if (!aktiv.some(s => s.id === raum.host)) raum.host = aktiv[0].id;
  olympPruefen(raum);
  raumSenden(raum);
  allePruefen(raum);
}

/* ---------- Olympiade ----------
   Mit einem Olympia-Ticket landet man im Raum seiner Disziplin (ein Raum pro Lauf und Gruppe).
   Die Einstellungen kommen von der Olympiade; sind alle da, startet das Spiel von selbst.
   Am Ende geht die Rangliste an die Olympiade. */
const OLYMP_START_MS = 6000;
const OLYMP_WARTEN_MS = 90_000;   // fehlt jemand, geht es spätestens so lange nach dem Öffnen des Raums los
function olympInfo(raum){
  const o = raum.olymp, da = new Set([...raum.spieler.values()].filter(s => !s.weg).map(s => s.olympId));
  return {
    ...olymp.fuerBrowser(o.t), erwartet:o.t.m.map(e => ({ n:e.n, da:da.has(e.s) })), gestartet:o.gestartet, vorbei:o.gemeldet,
    startIn:o.startBis ? Math.max(0, o.startBis - Date.now()) : null
  };
}
function olympPruefen(raum){
  const o = raum.olymp;
  if (!o) return;
  const da = [...raum.spieler.values()].filter(s => !s.weg).map(s => s.olympId).filter(Boolean);
  olymp.status(o.t, da, raum.phase === 'lobby' ? 'warten' : 'laeuft');
  const alle = o.t.m.every(e => da.includes(e.s));
  // Startzeit: spätestens nach der Wartezeit, sind alle da, nach dem kurzen Countdown
  let ziel = 0;
  if (raum.phase === 'lobby' && !o.gestartet && da.length){
    ziel = o.spaetestens;
    if (alle) ziel = Math.min(ziel, o.startUhr && o.startBis < o.spaetestens ? o.startBis : Date.now() + OLYMP_START_MS);
  }
  if (ziel === o.startBis && (o.startUhr || !ziel)) return;
  clearTimeout(o.startUhr); o.startUhr = null; o.startBis = 0;
  if (!ziel) return;
  o.startBis = ziel;
  o.startUhr = setTimeout(() => {
    o.startUhr = null;
    if (raeume.get(raum.code) === raum && raum.phase === 'lobby' && !o.gestartet) spielStarten(raum);
  }, Math.max(0, ziel - Date.now()));
}
function olympBeitreten(ws, raum, m){
  const t = olymp.ticketPruefen(m.ticket);
  if (!t) return sende(ws, { t:'fehler', text:'Das Olympia-Ticket ist ungültig oder abgelaufen. Geh zurück zur Olympiade.', code:'olymp' });
  const schluessel = t.l + ':' + t.g;
  let ziel = olympRaeume.get(schluessel);
  if (ziel && !raeume.has(ziel.code)) ziel = null;
  if (!ziel){
    if (raeume.size >= MAX_RAEUME) return sende(ws, { t:'fehler', text:'Gerade sind zu viele Spiele offen. Versuch es gleich noch mal.' });
    ziel = { code:neuerCode(), privat:false, host:null, phase:'lobby',
      einst:einstellungenPruefen({ runden:t.c.runden, zeit:t.c.zeit, region:'welt', bewegen:true }),
      spieler:new Map(), runde:0, orte:[], verlauf:[], gesehen:new Set(), timer:null, ende:0,
      olymp:{ t, gestartet:false, gemeldet:false, startUhr:null, startBis:0, spaetestens:Date.now() + OLYMP_WARTEN_MS } };
    raeume.set(ziel.code, ziel);
    olympRaeume.set(schluessel, ziel);
  }
  // Wiederkommen (neu geladen, Verbindung weg): den alten Platz übernehmen
  const alt = [...ziel.spieler.values()].find(s => s.olympId === t.s);
  if (!alt && ziel.olymp.gestartet) return sende(ws, { t:'fehler', text:'Diese Olympia-Runde läuft schon ohne dich.', code:'olymp' });
  if (raum && raum !== ziel) verlassen(ws, true);
  beitreten(ws, ziel, t.n, alt ? alt.token : null, t.s);
}
function olympMelden(raum){
  const o = raum.olymp;
  if (!o || o.gemeldet) return;
  o.gemeldet = true;
  const liste = [...raum.spieler.values()].filter(s => s.olympId).sort((a, b) => b.punkte - a.punkte)
    .map(s => ({ s:s.olympId, wert:s.punkte, text:`${s.punkte.toLocaleString('de-DE')} Punkte` }));
  olymp.rangMelden(o.t, liste);
}

function beitreten(ws, raum, name, token, olympId){
  // Wiederkommen nach Verbindungsabbruch
  if (token){
    for (const s of raum.spieler.values()){
      if (s.token === token){
        if (s.ws && s.ws !== ws){ const alt = s.ws; alt.raum = null; try { alt.close(); } catch {} }
        clearTimeout(s.wegTimer);
        s.ws = ws; s.weg = false; ws.id = s.id; ws.raum = raum;
        sende(ws, { t:'drin', code:raum.code, token:s.token, id:s.id });
        olympPruefen(raum);
        raumSenden(raum);
        nachholen(raum, s);
        return;
      }
    }
  }
  if (raum.spieler.size >= MAX_SPIELER) return sende(ws, { t:'fehler', text:'Der Raum ist voll.' });
  const id = crypto.randomBytes(4).toString('hex');
  const s = { id, name:nameOk(name), ws, punkte:0, tipp:null, weg:false, token:crypto.randomBytes(12).toString('hex'), olympId:olympId || null };
  ws.id = id; ws.raum = raum;
  raum.spieler.set(id, s);
  if (!raum.host) raum.host = id;
  sende(ws, { t:'drin', code:raum.code, token:s.token, id });
  olympPruefen(raum);
  raumSenden(raum);
  nachholen(raum, s);
}
// Wer mitten im Spiel (wieder) dazukommt, bekommt den aktuellen Stand
function nachholen(raum, s){
  if (raum.phase === 'runde'){
    const o = raum.orte[raum.runde - 1];
    sende(s.ws, { t:'runde', nr:raum.runde, von:raum.einst.runden, graph:rundenGraph(raum, o), rest:raum.ende ? Math.max(0, raum.ende - Date.now()) : 0, blick:0, schonGeraten:!!s.tipp });
  } else if ((raum.phase === 'aufloesung' || raum.phase === 'ende') && raum.verlauf.length){
    const v = raum.verlauf[raum.verlauf.length - 1];
    sende(s.ws, { t:'aufloesung', nr:raum.runde, von:raum.einst.runden, ...v, letzte:raum.phase === 'ende' });
    if (raum.phase === 'ende'){
      const rangliste = [...raum.spieler.values()].map(x => ({ id:x.id, name:x.name, punkte:x.punkte })).sort((a, b) => b.punkte - a.punkte);
      sende(s.ws, { t:'ende', rangliste, verlauf:raum.verlauf, max:5000 * raum.einst.runden });
    }
  }
}

const zahl = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

wss.on('connection', ws => {
  ws.lebt = true;
  sende(ws, { t:'hallo', regionen:REGIONEN.map(x => ({ id:x.id, name:x.name, anzahl:x.orte.length })), anzahl:ORTE.length });
  ws.on('pong', () => { ws.lebt = true; });
  ws.on('message', roh => {
    let m;
    try { m = JSON.parse(roh); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const raum = ws.raum;
    const istHost = raum && raum.host === ws.id;

    switch (m.t){
      case 'erstellen': {
        if (raum) verlassen(ws, true);
        if (raeume.size >= MAX_RAEUME) return sende(ws, { t:'fehler', text:'Gerade sind zu viele Spiele offen. Versuch es gleich noch mal.' });
        const neu = { code:neuerCode(), privat:!!m.privat, host:null, phase:'lobby', einst:einstellungenPruefen(m.einst),
          spieler:new Map(), runde:0, orte:[], verlauf:[], gesehen:new Set(), timer:null, ende:0 };
        raeume.set(neu.code, neu);
        beitreten(ws, neu, m.name);
        if (neu.privat) spielStarten(neu);
        break;
      }
      case 'beitreten': {
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        const ziel = raeume.get(code);
        const tok = typeof m.token === 'string' ? m.token : '';
        if (!ziel || (ziel.privat && ![...ziel.spieler.values()].some(s => s.token === tok))) return sende(ws, { t:'fehler', text:'Diesen Raum gibt es nicht (mehr).', code:'kein-raum' });
        if (raum && raum !== ziel) verlassen(ws, true);
        beitreten(ws, ziel, m.name, tok);
        break;
      }
      case 'olymp': olympBeitreten(ws, raum, m); break;
      case 'verlassen': verlassen(ws, true); break;
      case 'einst':
        if (!istHost || raum.phase !== 'lobby' || raum.olymp) return;
        raum.einst = einstellungenPruefen(m.einst, raum.einst);
        raumSenden(raum);
        break;
      case 'start':
        if (!istHost || (raum.phase !== 'lobby' && raum.phase !== 'ende')) return;
        if (raum.olymp && raum.olymp.gestartet) return;   // in der Olympiade gibt es genau ein Spiel
        spielStarten(raum);
        break;
      case 'hier': {
        // Spieler ist auf ein anderes Panorama gegangen: die nächsten Schritte vorladen
        if (!raum || raum.phase !== 'runde' || !raum.einst.bewegen) return;
        const o = raum.orte[raum.runde - 1];
        if (Number.isInteger(m.i) && m.i >= 0 && m.i < o.graph.knoten.length) vorladen(o, m.i, 2);
        break;
      }
      case 'tipp': {
        if (!raum || raum.phase !== 'runde') return;
        const s = raum.spieler.get(ws.id);
        if (!s || s.tipp || !zahl(m.lat, -90, 90) || !zahl(m.lon, -1080, 1080)) return;
        let lon = ((m.lon + 180) % 360 + 360) % 360 - 180;
        s.tipp = { lat:m.lat, lon };
        raumSenden(raum);
        allePruefen(raum);
        break;
      }
      case 'weiter':
        if (!raum || raum.phase !== 'aufloesung') return;
        if (!istHost && !raum.privat) return;
        rundeStarten(raum);
        break;
      case 'lobby':
        if (!istHost || raum.phase !== 'ende' || raum.privat || raum.olymp) return;
        raum.phase = 'lobby'; raum.runde = 0;
        for (const s of raum.spieler.values()){ s.punkte = 0; s.tipp = null; }
        raumSenden(raum);
        break;
      case 'nochmal':
        // Allein: gleich die nächste Partie mit denselben Einstellungen (oder neuen)
        if (!raum || !raum.privat || raum.phase !== 'ende') return;
        raum.einst = einstellungenPruefen(m.einst, raum.einst);
        spielStarten(raum);
        break;
    }
  });
  ws.on('close', () => verlassen(ws, false));
});

setInterval(() => {
  for (const ws of wss.clients){
    if (!ws.lebt){ ws.terminate(); continue; }
    ws.lebt = false;
    try { ws.ping(); } catch {}
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`Weltenbummler läuft auf http://localhost:${PORT}`));
