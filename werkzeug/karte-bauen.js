'use strict';
// Baut daten/welt.json aus Natural Earth (gemeinfrei): Ländergrenzen (vereinfacht),
// deutsche Ländernamen, Kontinente und ein paar große Städte für die Ratekarte.
// Aufruf: node werkzeug/karte-bauen.js
const fs = require('fs');
const path = require('path');

const hier = __dirname;
const laender = JSON.parse(fs.readFileSync(path.join(hier, 'ne50.geojson'), 'utf8'));
const orte = JSON.parse(fs.readFileSync(path.join(hier, 'ne_orte.geojson'), 'utf8'));

// Douglas-Peucker auf einem Ring (Grad als Einheit)
function vereinfachen(pkte, tol){
  if (pkte.length < 5) return pkte;
  const behalten = new Uint8Array(pkte.length);
  behalten[0] = behalten[pkte.length - 1] = 1;
  const stapel = [[0, pkte.length - 1]];
  while (stapel.length){
    const [a, b] = stapel.pop();
    const [ax, ay] = pkte[a], [bx, by] = pkte[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++){
      const [px, py] = pkte[i];
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > max){ max = d; idx = i; }
    }
    if (idx >= 0 && max > tol * tol){ behalten[idx] = 1; stapel.push([a, idx], [idx, b]); }
  }
  return pkte.filter((_, i) => behalten[i]);
}

const r2 = v => Math.round(v * 100) / 100;
const KONTINENT = {
  'Africa':'Afrika', 'Asia':'Asien', 'Europe':'Europa', 'North America':'Nordamerika',
  'South America':'Südamerika', 'Oceania':'Ozeanien', 'Antarctica':'Antarktis',
  'Seven seas (open ocean)':'Ozeanien'
};

let punkte = 0;
const aus = { laender:[], staedte:[] };
for (const f of laender.features){
  const p = f.properties, g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const ringe = [];
  for (const poly of polys){
    poly.forEach((ring, i) => {
      // Winzige Inseln und Löcher weglassen – spart viel Platz
      let minx = 999, maxx = -999, miny = 999, maxy = -999;
      for (const [x, y] of ring){ minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      if ((maxx - minx) * (maxy - miny) < 0.004 && ring.length < 12) return;
      const v = vereinfachen(ring, 0.025);
      if (v.length < 4) return;
      const flach = [];
      for (const [x, y] of v) flach.push(r2(x), r2(y));
      punkte += v.length;
      ringe.push(i === 0 ? flach : { loch:flach });
    });
  }
  // Löcher als eigenes Feld an den vorigen Ring hängen wäre genauer; die Karte
  // zeichnet mit evenodd, deshalb reichen flache Ringe.
  aus.laender.push({
    n: p.NAME_DE || p.NAME, k: KONTINENT[p.CONTINENT] || p.CONTINENT, iso: p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : '',
    lx: r2(p.LABEL_X), ly: r2(p.LABEL_Y), lr: p.MIN_LABEL,
    r: ringe.map(x => (Array.isArray(x) ? x : x.loch))
  });
}
for (const f of orte.features){
  const p = f.properties;
  aus.staedte.push({ n:p.name, lat:r2(p.latitude), lon:r2(p.longitude), r:p.scalerank });
}
fs.writeFileSync(path.join(hier, '..', 'daten', 'welt.json'), JSON.stringify(aus));
console.log('Länder:', aus.laender.length, 'Punkte:', punkte, 'Größe:', fs.statSync(path.join(hier, '..', 'daten', 'welt.json')).size);
