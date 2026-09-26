'use strict';
// Baut begehbare Strecken wie bei Street View: Mapillary-Fahrten liegen auf Wikimedia
// Commons als Sequenz-Kategorie ("Photographs of … from Mapillary (SEQUENZ)"), mit
// Koordinaten, Aufnahmezeit und meist auch Blickrichtung. Aus den Bildern rund um
// einen Startpunkt entsteht ein kleiner Weg-Graph. Nur das Startbild wird hier
// heruntergeladen (panos/), die übrigen holt der Server bei Bedarf und speichert sie
// zwischen – so bleibt das Repo klein und die Spieler verbinden sich nie mit Wikimedia.
//
// Aufruf:  node werkzeug/strecken-bauen.js           (sucht, baut, lädt Startbilder)
//          node werkzeug/strecken-bauen.js --blatt   (Kontaktbogen der Startbilder)
//          node werkzeug/strecken-bauen.js --weg a1b2,c3d4   (Strecken per Start-ID verwerfen)
//          node werkzeug/strecken-bauen.js --probe   (Richtungs-Test: Ausschnitte in Laufrichtung)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { SAAT } = require('./saat');

const WURZEL = path.join(__dirname, '..');
const STRECKEN = path.join(WURZEL, 'daten', 'strecken.json');
const PANOS = path.join(WURZEL, 'panos');
const ALT = path.join(WURZEL, 'daten', 'orte.json');
const UA = { 'User-Agent':'Weltenbummler/1.0 (privates Familien-Spiel; +https://github.com/taddelcoder-svg/taddelgeo)' };
const RADIUS = 280;           // m um den Start
const MIN_ABSTAND = 7;        // m zwischen zwei Knoten
const MAX_SPRUNG = 45;        // m – weiter auseinander wird nicht verbunden
const MIN_KNOTEN = 12, MAX_KNOTEN = 70;
const PRO_SAAT = 2;
const warte = ms => new Promise(r => setTimeout(r, ms));

async function api(p){
  const u = 'https://commons.wikimedia.org/w/api.php?format=json&formatversion=2&' + new URLSearchParams(p);
  for (let v = 0; v < 5; v++){
    try {
      const r = await fetch(u, { headers:UA });
      if (r.ok) return await r.json();
    } catch {}
    await warte(3000 * (v + 1));
  }
  return {};
}
// Abfrage mit Fortsetzung; Seiten werden nach Titel zusammengeführt
async function alle(p, max = 5000){
  const seiten = new Map();
  let cont = {};
  for (let n = 0; n < 40; n++){
    const j = await api({ ...p, ...cont });
    for (const s of (j.query && j.query.pages) || []){
      const alt = seiten.get(s.title) || {};
      seiten.set(s.title, { ...alt, ...s, coordinates:s.coordinates || alt.coordinates, imageinfo:s.imageinfo || alt.imageinfo, revisions:s.revisions || alt.revisions, categories:(alt.categories || []).concat(s.categories || []) });
    }
    if (!j.continue || seiten.size >= max) break;
    cont = j.continue;
    await warte(250);
  }
  return [...seiten.values()];
}

const text = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const LIZENZ_OK = /^(CC BY(-SA)? [1-4]\.0|CC0|Public domain|PD)/i;
function meter(a, b){
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function peilung(a, b){
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const winkelDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Details (Richtung, Zeit, Lizenz, Bildadresse) für bis zu 50 Titel auf einmal
async function details(titel){
  const aus = [];
  for (let i = 0; i < titel.length; i += 50){
    const teil = titel.slice(i, i + 50);
    const seiten = await alle({
      action:'query', titles:teil.join('|'), prop:'revisions|coordinates|imageinfo', rvprop:'content', rvslots:'main',
      colimit:'max', iiprop:'url|size|extmetadata', iiurlwidth:3840, iiextmetadatafilter:'LicenseShortName|Artist|LicenseUrl'
    });
    for (const s of seiten){
      const ii = s.imageinfo && s.imageinfo[0], k = s.coordinates && s.coordinates[0];
      const wt = s.revisions && s.revisions[0] && s.revisions[0].slots && s.revisions[0].slots.main.content || '';
      if (!ii || !k || Math.abs(ii.width / ii.height - 2) > 0.02 || ii.width < 3000) continue;
      const em = ii.extmetadata || {};
      const lizenz = text(em.LicenseShortName && em.LicenseShortName.value);
      if (!LIZENZ_OK.test(lizenz)) continue;
      const h = /heading:\s*([-\d.]+)/.exec(wt);
      // Zeit am genauesten aus dem Dateinamen (mit Millisekunden), sonst aus {{Taken on}}
      const tz = /(\d{4}-\d\d-\d\d) (\d\d)H(\d\d)(?:M|mn)(\d\d)[sS](\d{3})/.exec(s.title);
      const zeit = tz ? [0, `${tz[1]}T${tz[2]}:${tz[3]}:${tz[4]}.${tz[5]}Z`] : /Taken on\|(?:[^|}]*=[^|}]*\|)*(\d{4}-\d\d-\d\dT[\d:]+Z?)/.exec(wt);
      const seq = /Sequence ID:\s*([\w-]+)/.exec(wt);
      aus.push({
        titel:s.title, lat:+k.lat.toFixed(6), lon:+k.lon.toFixed(6),
        h:h ? ((+h[1] % 360) + 360) % 360 : null, zeit:zeit ? Date.parse(zeit[1]) || 0 : 0, seq:seq ? seq[1] : '',
        bild:ii.thumburl || ii.url, seite:ii.descriptionurl, lizenz, lizenzUrl:text(em.LicenseUrl && em.LicenseUrl.value),
        urheber:text(em.Artist && em.Artist.value).slice(0, 120) || 'unbekannt'
      });
    }
    await warte(300);
  }
  return aus;
}

// Aus den Bildern einer Fahrt einen Weg-Graphen um den Start bauen
function graphBauen(bilder, start){
  // In Aufnahmereihenfolge, fehlende Richtung aus der Fahrtrichtung ergänzen
  bilder.sort((a, b) => (a.zeit - b.zeit) || a.titel.localeCompare(b.titel));
  for (let i = 0; i < bilder.length; i++){
    if (bilder[i].h != null) continue;
    const v = bilder[Math.max(0, i - 1)], n = bilder[Math.min(bilder.length - 1, i + 1)];
    if (v !== n && meter(v, n) > 2) bilder[i].h = peilung(v, n);
  }
  const mitRichtung = bilder.filter(b => b.h != null);
  // Ausdünnen: nur Knoten mit Mindestabstand zum zuletzt behaltenen und zu allen anderen
  const knoten = [];
  for (const b of mitRichtung){
    if (knoten.some(k => meter(k, b) < MIN_ABSTAND)) continue;
    knoten.push(b);
  }
  // Kanten: zeitlich aufeinanderfolgende Knoten, außerdem sehr nahe Knoten (Kreuzungen, zweimal befahren)
  const kanten = new Set();
  const key = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  for (let i = 1; i < knoten.length; i++) if (meter(knoten[i - 1], knoten[i]) <= MAX_SPRUNG) kanten.add(key(i - 1, i));
  for (let i = 0; i < knoten.length; i++) for (let j = i + 2; j < knoten.length; j++){
    if (meter(knoten[i], knoten[j]) < MIN_ABSTAND * 1.9) kanten.add(key(i, j));
  }
  const nachbarn = knoten.map(() => []);
  for (const k of kanten){ const [a, b] = k.split('-').map(Number); nachbarn[a].push(b); nachbarn[b].push(a); }
  // Pro Knoten höchstens einen Nachbarn je Richtung (sonst liegen zwei Pfeile übereinander)
  for (let i = 0; i < knoten.length; i++){
    const sortiert = nachbarn[i].sort((a, b) => meter(knoten[i], knoten[a]) - meter(knoten[i], knoten[b]));
    const behalten = [];
    for (const n of sortiert){
      const p = peilung(knoten[i], knoten[n]);
      if (behalten.some(m => winkelDiff(peilung(knoten[i], knoten[m]), p) < 25)) continue;
      behalten.push(n);
    }
    nachbarn[i] = behalten;
  }
  for (let i = 0; i < knoten.length; i++) nachbarn[i] = nachbarn[i].filter(n => nachbarn[n].includes(i));
  // Start = Knoten am nächsten am gewünschten Punkt; Breitensuche ab da
  let s = 0;
  knoten.forEach((k, i) => { if (meter(k, start) < meter(knoten[s], start)) s = i; });
  const neu = new Map([[s, 0]]), schlange = [s];
  while (schlange.length && neu.size < MAX_KNOTEN){
    const a = schlange.shift();
    for (const b of nachbarn[a]) if (!neu.has(b) && neu.size < MAX_KNOTEN){ neu.set(b, neu.size); schlange.push(b); }
  }
  const liste = [...neu.keys()];
  const kn = liste.map(i => knoten[i]);
  const kantenNeu = [];
  for (const a of liste) for (const b of nachbarn[a]) if (neu.has(b) && neu.get(a) < neu.get(b)) kantenNeu.push([neu.get(a), neu.get(b)]);
  let laenge = 0;
  for (const [a, b] of kantenNeu) laenge += meter(kn[a], kn[b]);
  return { knoten:kn, kanten:kantenNeu, laenge };
}

async function streckeAus(kategorie, startPunkt){
  // Alle Bilder der Fahrt mit Koordinaten, dann nur die in der Nähe des Starts genauer ansehen
  const mitglieder = await alle({ action:'query', generator:'categorymembers', gcmtitle:kategorie, gcmtype:'file', gcmlimit:500, prop:'coordinates', colimit:'max' }, 6000);
  const nah = mitglieder.filter(m => m.coordinates && meter(startPunkt, m.coordinates[0]) <= RADIUS);
  if (nah.length < MIN_KNOTEN) return null;
  // Bei sehr dichten Fahrten reicht jedes zweite/dritte Bild
  nah.sort((a, b) => a.title.localeCompare(b.title));
  const schritt = Math.max(1, Math.floor(nah.length / 160));
  const auswahl = nah.filter((_, i) => i % schritt === 0).map(m => m.title);
  const bilder = await details(auswahl);
  if (bilder.length < MIN_KNOTEN) return null;
  const g = graphBauen(bilder, startPunkt);
  if (g.knoten.length < MIN_KNOTEN || g.laenge < 120) return null;
  return g;
}

async function suchen(){
  const strecken = fs.existsSync(STRECKEN) ? JSON.parse(fs.readFileSync(STRECKEN, 'utf8')) : [];
  const erledigt = new Set(strecken.map(s => s.saat));
  const verworfen = new Set(fs.existsSync(path.join(__dirname, 'verworfen.txt')) ? fs.readFileSync(path.join(__dirname, 'verworfen.txt'), 'utf8').split(/\r?\n/).filter(Boolean) : []);
  const alteOrte = fs.existsSync(ALT) ? JSON.parse(fs.readFileSync(ALT, 'utf8')) : [];
  for (const [saat, la, lo] of SAAT){
    if (erledigt.has(saat)) continue;
    // Kandidaten: erst frühere Orte dieser Gegend (Startbild liegt schon vor), dann eine neue Suche
    const kandidaten = alteOrte.filter(o => o.saat === saat && /Mapillary/.test(o.titel)).map(o => ({ titel:o.titel, lat:o.lat, lon:o.lon, altId:o.id }));
    const j = await api({ action:'query', generator:'search', gsrnamespace:6, gsrlimit:50,
      gsrsearch:`nearcoord:150km,${la},${lo} incategory:"360°_panoramas" intitle:Mapillary`, prop:'coordinates', colimit:'max' });
    for (const p of ((j.query && j.query.pages) || []).sort(() => Math.random() - 0.5)){
      if (p.coordinates) kandidaten.push({ titel:p.title, lat:p.coordinates[0].lat, lon:p.coordinates[0].lon });
    }
    let fertig = 0;
    const benutzt = [];
    for (const k of kandidaten){
      if (fertig >= PRO_SAAT) break;
      if (verworfen.has(k.titel)) continue;
      if (benutzt.some(b => meter(b, k) < 20000) || strecken.some(s => meter(s.knoten[s.start], k) < 20000)) continue;
      const kat = await api({ action:'query', titles:k.titel, prop:'categories', cllimit:'max', clshow:'!hidden' });
      const seite = kat.query && kat.query.pages && kat.query.pages[0];
      const kategorie = ((seite && seite.categories) || []).map(c => c.title).find(t => /from Mapillary \(/.test(t));
      if (!kategorie) continue;
      benutzt.push(k);
      let g;
      try { g = await streckeAus(kategorie, k); } catch (e){ console.log('  Fehler', e.message); }
      if (!g) { console.log('  zu kurz:', kategorie.slice(9, 70)); continue; }
      // Startknoten: wenn es das frühere Startbild ist, die Datei weiterverwenden
      const s = g.knoten.findIndex(x => x.titel === k.titel);
      const start = s >= 0 ? s : 0;
      const knoten = g.knoten.map((x, i) => ({ id:(i === start && k.altId && s >= 0) ? k.altId : crypto.randomBytes(6).toString('hex'), ...x }));
      strecken.push({ id:crypto.randomBytes(4).toString('hex'), saat, kategorie, start, knoten, kanten:g.kanten, laenge:Math.round(g.laenge) });
      fertig++;
      console.log(`✓ ${saat.padEnd(26)} ${String(knoten.length).padStart(3)} Knoten, ${Math.round(g.laenge)} m  ${kategorie.slice(9, 70)}`);
      fs.writeFileSync(STRECKEN, JSON.stringify(strecken));
    }
    if (!fertig) console.log(`– ${saat}: keine Strecke`);
    await warte(300);
  }
  return strecken;
}

// Startbilder in voller Qualität herunterladen (die übrigen holt der Server bei Bedarf)
async function startbilder(strecken){
  for (const s of strecken){
    const k = s.knoten[s.start];
    const ziel = path.join(PANOS, k.id + '.jpg');
    if (fs.existsSync(ziel)) continue;
    try {
      let r;
      for (let v = 0; v < 4; v++){
        r = await fetch(k.bild, { headers:UA });
        if (r.status !== 429 && r.status < 500) break;
        await warte(5000 * (v + 1));
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const roh = Buffer.from(await r.arrayBuffer());
      await sharp(roh).resize(3072, 1536, { fit:'fill' }).jpeg({ quality:72, mozjpeg:true }).toFile(ziel);
      console.log('Startbild', s.saat, k.id);
    } catch (e){ console.log('  Fehler Startbild', s.saat, e.message); }
    await warte(800);
  }
}

// Richtungs-Test: Aus dem Startbild den Ausschnitt in Richtung des ersten Nachbarn schneiden.
// Stimmt die Annahme (Bildmitte = Blickrichtung h), zeigt der Ausschnitt die Straße voraus.
// Mit --probe4 id,id,… gibt es je Strecke vier Ausschnitte (0°, +90°, 180°, −90° Korrektur) nebeneinander
async function probe(nur){
  let strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
  if (nur) strecken = nur.flatMap(id => [0, 90, 180, 270].map(w => {
    const s = strecken.find(x => x.id === id);
    return s && { ...s, korrektur:(s.korrektur || 0) + w };
  })).filter(Boolean);
  const G = 256, SP = nur ? 4 : 6, PRO = nur ? 48 : 42;
  for (let seite = 0; seite * PRO < strecken.length; seite++){
  const bilder = [];
  for (const s of strecken.slice(seite * PRO, (seite + 1) * PRO)){
    const k = s.knoten[s.start];
    const kante = s.kanten.find(([a, b]) => a === s.start || b === s.start);
    if (!kante) continue;
    const n = s.knoten[kante[0] === s.start ? kante[1] : kante[0]];
    const p = peilung(k, n);
    const u = (((0.5 + (p - k.h - (s.korrektur || 0)) / 360) % 1) + 1) % 1;
    const datei = path.join(PANOS, k.id + '.jpg');
    if (!fs.existsSync(datei)) continue;
    // 90°-Ausschnitt um u (mit Umlauf über den Bildrand)
    const breit = await sharp(datei).resize(1536, 768).toBuffer();
    const doppelt = await sharp({ create:{ width:3072, height:768, channels:3, background:'#000' } })
      .composite([{ input:breit, left:0, top:0 }, { input:breit, left:1536, top:0 }]).jpeg().toBuffer();
    let x = Math.round(u * 1536 - 192); if (x < 0) x += 1536;
    const aus = await sharp(doppelt).extract({ left:x, top:192, width:384, height:384 }).resize(G, G).toBuffer();
    const nr = Buffer.from(`<svg width="${G}" height="${G}"><rect width="96" height="24" fill="black" opacity=".7"/><text x="5" y="18" font-size="17" fill="yellow" font-family="Arial">${s.id}</text></svg>`);
    bilder.push(await sharp(aus).composite([{ input:nr, left:0, top:0 }]).toBuffer());
  }
  await sharp({ create:{ width:G * SP, height:G * Math.ceil(bilder.length / SP), channels:3, background:'#000' } })
    .composite(bilder.map((b, i) => ({ input:b, left:(i % SP) * G, top:Math.floor(i / SP) * G }))).jpeg({ quality:75 }).toFile(path.join(__dirname, `probe${nur ? '4' : ''}-${seite}.jpg`));
  }
  console.log('Probe-Bögen geschrieben');
}

// Paar-Probe zur Richtungsprüfung: je Strecke Bild A (Start) und B (3 Schritte weiter)
// in dieselbe Himmelsrichtung, einmal mit der jetzigen Korrektur und einmal um 90° gedreht.
// Stimmt die Richtung, ist in B alles näher/größer als in A; ist sie verkehrt, kleiner.
async function paare(){
  const strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
  const G = 192, PRO = 10;
  const holen = async k => {
    const lokal = path.join(PANOS, k.id + '.jpg');
    if (fs.existsSync(lokal)) return sharp(lokal).resize(1536, 768).toBuffer();
    const cache = path.join(__dirname, 'bilder-cache', k.id + '.jpg');
    if (fs.existsSync(cache)) return fs.readFileSync(cache);
    fs.mkdirSync(path.dirname(cache), { recursive:true });
    const r = await fetch(k.bild.replace(/\/\d+px-/, '/1920px-'), { headers:UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await sharp(Buffer.from(await r.arrayBuffer())).resize(1536, 768).jpeg({ quality:80 }).toBuffer();
    fs.writeFileSync(cache, b);
    return b;
  };
  const ausschnitt = async (buf, u) => {
    const doppelt = await sharp({ create:{ width:3072, height:768, channels:3, background:'#000' } })
      .composite([{ input:buf, left:0, top:0 }, { input:buf, left:1536, top:0 }]).jpeg().toBuffer();
    let x = Math.round(u * 1536 - 160); if (x < 0) x += 1536;
    return sharp(doppelt).extract({ left:x, top:224, width:320, height:320 }).resize(G, G).toBuffer();
  };
  const uVon = (p, h) => (((0.5 + (p - h) / 360) % 1) + 1) % 1;
  for (let seite = 0; seite * PRO < strecken.length; seite++){
    const kacheln = [];
    const teil = strecken.slice(seite * PRO, (seite + 1) * PRO);
    for (let i = 0; i < teil.length; i++){
      const s = teil[i];
      const nb = new Map(s.knoten.map((_, j) => [j, []]));
      for (const [a, b] of s.kanten){ nb.get(a).push(b); nb.get(b).push(a); }
      // 3 Schritte möglichst geradeaus
      let weg = [s.start];
      if (!nb.get(s.start).length) continue;
      weg.push(nb.get(s.start)[0]);
      while (weg.length < 4){
        const a = s.knoten[weg[weg.length - 2]], b = s.knoten[weg[weg.length - 1]];
        const richt = peilung(a, b);
        const weiter = nb.get(weg[weg.length - 1]).filter(n => !weg.includes(n))
          .sort((x, y) => winkelDiff(peilung(b, s.knoten[x]), richt) - winkelDiff(peilung(b, s.knoten[y]), richt))[0];
        if (weiter == null) break;
        weg.push(weiter);
      }
      const A = s.knoten[s.start], B = s.knoten[weg[weg.length - 1]];
      const p = peilung(A, B);
      try {
        const ba = await holen(A), bb = await holen(B);
        const k = s.korrektur || 0;
        for (const [n, extra] of [[0, 0], [1, 90]]){
          kacheln.push({ i, spalte:n * 2, bild:await ausschnitt(ba, uVon(p, A.h + k + extra)) });
          kacheln.push({ i, spalte:n * 2 + 1, bild:await ausschnitt(bb, uVon(p, B.h + k + extra)) });
        }
      } catch (e){ console.log('  Fehler', s.id, e.message); }
      await warte(200);
    }
    const zeilen = Math.ceil(teil.length / 2);
    const bilder = [];
    for (const k of kacheln){
      const x = ((k.i % 2) * 4 + k.spalte) * G + (k.i % 2) * 12, y = Math.floor(k.i / 2) * G;
      bilder.push({ input:k.bild, left:x, top:y });
      if (k.spalte === 0){
        const nr = Buffer.from(`<svg width="${G}" height="24"><rect width="96" height="22" fill="black" opacity=".75"/><text x="4" y="17" font-size="16" fill="yellow" font-family="Arial">${teil[k.i].id}</text></svg>`);
        bilder.push({ input:nr, left:x, top:y });
      }
    }
    await sharp({ create:{ width:G * 8 + 12, height:G * zeilen, channels:3, background:'#fff' } })
      .composite(bilder).jpeg({ quality:78 }).toFile(path.join(__dirname, `paare-${seite}.jpg`));
  }
  console.log('Paar-Bögen geschrieben');
}

// Blickrichtungen angleichen: Die gespeicherte Richtung schwankt von Bild zu Bild. Wir
// richten jedes Bild am Bildinhalt seines Nachbarn aus (Horizontstreifen, Kreuzkorrelation)
// und reichen die Richtung vom geprüften Startbild aus durch den ganzen Weg weiter.
const SW = 960, SH = 36;
async function streifen(k){
  const datei = path.join(__dirname, 'bilder-cache', k.id + '.streifen');
  if (fs.existsSync(datei)){ const b = fs.readFileSync(datei); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); }
  fs.mkdirSync(path.dirname(datei), { recursive:true });
  let roh;
  const lokal = path.join(PANOS, k.id + '.jpg');
  if (fs.existsSync(lokal)) roh = fs.readFileSync(lokal);
  else {
    let r;
    for (let v = 0; v < 4; v++){
      r = await fetch(k.bild.replace(/\/\d+px-/, '/960px-'), { headers:UA }).catch(() => null);
      if (r && r.status !== 429 && r.status < 500) break;
      await warte(4000 * (v + 1));
    }
    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
    roh = Buffer.from(await r.arrayBuffer());
  }
  const grau = await sharp(roh).resize(SW, SW / 2, { fit:'fill' }).greyscale().toBuffer();
  const px = await sharp(grau).extract({ left:0, top:Math.round(SW / 2 * 0.3), width:SW, height:Math.round(SW / 2 * 0.25) }).resize(SW, SH, { fit:'fill' }).raw().toBuffer();
  const f = Float32Array.from(px);
  fs.writeFileSync(datei, Buffer.from(f.buffer));
  return f;
}
// Um wie viel Grad ist B gegenüber A gedreht? (Inhalt bei Spalte x in A liegt in B bei x + d)
function drehung(A, B){
  const bewerten = d => {
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x += 2){
      const a = A[y * SW + x], b = B[y * SW + (x + d + SW) % SW];
      sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b; n++;
    }
    return (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n) + 1e-6);
  };
  let best = 0, bv = -2;
  for (let d = 0; d < SW; d += 3){ const v = bewerten(d); if (v > bv){ bv = v; best = d; } }
  for (let d = best - 3; d <= best + 3; d++){ const v = bewerten((d + SW) % SW); if (v > bv){ bv = v; best = (d + SW) % SW; } }
  let grad = best / SW * 360; if (grad > 180) grad -= 360;
  return { grad, guete:bv };
}
async function ausrichten(){
  const strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
  for (const s of strecken){
    if (s.ausgerichtet) continue;
    const nb = s.knoten.map(() => []);
    for (const [a, b] of s.kanten){ nb[a].push(b); nb[b].push(a); }
    const korr = s.korrektur || 0;
    // Fahrtrichtung je Knoten (aus Vorgänger und Nachfolger in der Aufnahmereihenfolge).
    // Die Kamera ist fest am Fahrzeug: dreht sich die Fahrtrichtung, dreht sich das Bild mit.
    const reihe = s.knoten.map((k, i) => i).filter(i => s.knoten[i].zeit).sort((a, b) => s.knoten[a].zeit - s.knoten[b].zeit);
    const fahrt = s.knoten.map(() => null);
    reihe.forEach((i, r) => {
      const v = s.knoten[reihe[Math.max(0, r - 1)]], n = s.knoten[reihe[Math.min(reihe.length - 1, r + 1)]];
      if (v !== n && meter(v, n) < 80) fahrt[i] = peilung(v, n);
    });
    const deltaFahrt = (a, b) => (fahrt[a] != null && fahrt[b] != null ? ((fahrt[b] - fahrt[a] + 540) % 360) - 180 : 0);
    const neu = new Map([[s.start, s.knoten[s.start].h + korr]]);
    const schlange = [s.start];
    let schlecht = 0;
    while (schlange.length){
      const a = schlange.shift();
      for (const b of nb[a]){
        if (neu.has(b)) continue;
        // Rückfall: Richtung mitdrehen wie die Fahrtrichtung
        const erwartet = deltaFahrt(a, b);
        let hb = neu.get(a) + erwartet;
        try {
          const d = drehung(await streifen(s.knoten[a]), await streifen(s.knoten[b]));
          // Bildvergleich übernehmen, wenn er eindeutig ist und zur Fahrt passt
          if (d.guete >= 0.45 && winkelDiff(-d.grad, erwartet) < 45) hb = neu.get(a) - d.grad; else schlecht++;
        } catch (e){ schlecht++; }
        neu.set(b, ((hb % 360) + 360) % 360);
        schlange.push(b);
      }
    }
    for (const [i, h] of neu) s.knoten[i].h = Math.round(h * 10) / 10;
    s.korrektur = 0; s.ausgerichtet = true;
    console.log(`ausgerichtet ${s.id} ${s.saat.padEnd(26)} ${s.knoten.length} Knoten, ${schlecht} unsicher`);
    fs.writeFileSync(STRECKEN, JSON.stringify(strecken));
  }
}

async function blatt(){
  const strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
  const B = 384, H = 192, SP = 4, pro = 40;
  for (let s = 0; s * pro < strecken.length; s++){
    const teil = strecken.slice(s * pro, (s + 1) * pro);
    const bilder = [];
    for (let i = 0; i < teil.length; i++){
      const k = teil[i].knoten[teil[i].start];
      const datei = path.join(PANOS, k.id + '.jpg');
      if (!fs.existsSync(datei)) continue;
      const klein = await sharp(datei).resize(B, H).toBuffer();
      const nr = Buffer.from(`<svg width="${B}" height="${H}"><rect width="170" height="26" fill="black" opacity=".7"/><text x="6" y="19" font-size="18" fill="yellow" font-family="Arial">${s * pro + i} ${teil[i].id} ${teil[i].knoten.length}</text></svg>`);
      bilder.push({ input:klein, left:(i % SP) * B, top:Math.floor(i / SP) * H }, { input:nr, left:(i % SP) * B, top:Math.floor(i / SP) * H });
    }
    await sharp({ create:{ width:B * SP, height:H * Math.ceil(teil.length / SP), channels:3, background:'#000' } })
      .composite(bilder).jpeg({ quality:70 }).toFile(path.join(__dirname, `blatt-${s}.jpg`));
  }
  console.log('Kontaktbögen geschrieben');
}

(async () => {
  fs.mkdirSync(PANOS, { recursive:true });
  if (process.argv.includes('--blatt')) return blatt();
  if (process.argv.includes('--probe')) return probe();
  if (process.argv.includes('--paare')) return paare();
  if (process.argv.includes('--ausrichten')) return ausrichten();
  const p4 = process.argv.indexOf('--probe4');
  if (p4 > 0) return probe((process.argv[p4 + 1] || '').split(',').filter(Boolean));
  // --drehen id:90,id2:180  → Kamera war verdreht montiert, Korrektur für die ganze Strecke
  const dreh = process.argv.indexOf('--drehen');
  if (dreh > 0){
    const strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
    for (const t of (process.argv[dreh + 1] || '').split(',')){
      const [id, w] = t.split(':');
      const s = strecken.find(x => x.id === id);
      if (s){ s.korrektur = (((s.korrektur || 0) + Number(w)) % 360 + 360) % 360; console.log('gedreht:', id, s.korrektur); }
    }
    fs.writeFileSync(STRECKEN, JSON.stringify(strecken));
    return;
  }
  const weg = process.argv.indexOf('--weg');
  if (weg > 0){
    const ids = (process.argv[weg + 1] || '').split(',').filter(Boolean);
    const strecken = JSON.parse(fs.readFileSync(STRECKEN, 'utf8'));
    const raus = strecken.filter(s => ids.includes(s.id));
    fs.appendFileSync(path.join(__dirname, 'verworfen.txt'), raus.map(s => s.knoten[s.start].titel + '\n').join(''));
    for (const s of raus){ try { fs.unlinkSync(path.join(PANOS, s.knoten[s.start].id + '.jpg')); } catch {} console.log('verworfen:', s.id, s.saat); }
    fs.writeFileSync(STRECKEN, JSON.stringify(strecken.filter(s => !raus.includes(s))));
    return;
  }
  const strecken = await suchen();
  await startbilder(strecken);
  // Alte Einzelbilder, die kein Startbild mehr sind, aufräumen
  const behalten = new Set(strecken.map(s => s.knoten[s.start].id + '.jpg'));
  for (const f of fs.readdirSync(PANOS)) if (!behalten.has(f)) fs.unlinkSync(path.join(PANOS, f));
  console.log('Strecken gesamt:', strecken.length, 'Knoten:', strecken.reduce((n, s) => n + s.knoten.length, 0));
})();
