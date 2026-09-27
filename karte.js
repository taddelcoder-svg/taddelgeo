'use strict';
// Weltkarte zum Raten: MapLibre (Vektorkarte) mit OpenFreeMap-Daten. Alles kommt über den
// eigenen Server (/vkarte/…, /kartenstil.json). Beschriftungen sind vereinheitlicht:
// deutscher Name, sonst lateinische Schreibweise (siehe werkzeug/kartenstil-bauen.js).
(function(){
  let stilLaden = null;
  function stil(){
    // Pfade im Stil sind relativ – MapLibre braucht volle Adressen
    stilLaden = stilLaden || fetch('/kartenstil.json').then(r => r.json()).then(s => {
      const o = location.origin;
      for (const q of Object.values(s.sources)) if (q.tiles) q.tiles = q.tiles.map(t => o + t);
      s.glyphs = o + s.glyphs; s.sprite = o + s.sprite;
      return s;
    });
    return stilLaden;
  }

  const escHtml = t => String(t).replace(/[&<>"']/g, z => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[z]));
  function nadelElement(farbe, text){
    const el = document.createElement('div');
    el.className = 'karten-nadel';
    const innen = text
      ? `<text x="14" y="15.5" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Barlow SC, system-ui, sans-serif">${escHtml(text.slice(0, 2).toUpperCase())}</text>`
      : '<circle cx="14" cy="12" r="4.2" fill="#fff"/>';
    el.innerHTML = `<svg viewBox="0 0 28 38" width="28" height="38" aria-hidden="true"><path d="M14 37C14 37 2 22 2 13a12 12 0 0 1 24 0c0 9-12 24-12 24z" fill="${farbe}" stroke="#fff" stroke-width="2.5"/>${innen}</svg>`;
    return el;
  }
  function flaggeElement(){
    const el = document.createElement('div');
    el.className = 'karten-nadel';
    el.innerHTML = '<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><circle cx="4" cy="36" r="3.5" fill="#16202c" stroke="#fff" stroke-width="1.5"/><path d="M4 36V3" stroke="#16202c" stroke-width="2.5"/><path d="M5 3l22 7-22 8z" fill="#20b35a" stroke="#fff" stroke-width="1.5"/></svg>';
    return el;
  }
  const naheLon = (lon, ref) => { while (lon - ref > 180) lon -= 360; while (lon - ref < -180) lon += 360; return lon; };

  class Karte {
    // opt.onKlick(lat, lon): Tipp setzen; opt.ziehbar: eigene Nadel lässt sich verschieben
    constructor(el, opt = {}){
      this.el = el;
      this.onKlick = opt.onKlick || null;
      this.ziehbar = !!opt.ziehbar;
      this.marker = [];
      this.linien = [];
      this.bereit = false;
      this.karte = null;
      stil().then(s => this.starten(s)).catch(() => { el.textContent = 'Karte konnte nicht geladen werden.'; });
    }
    starten(s){
      const k = this.karte = new maplibregl.Map({
        container:this.el, style:s, center:[10, 25], zoom:this.weltZoom(),
        minZoom:0, maxZoom:18, dragRotate:false, pitchWithRotate:false, touchPitch:false,
        attributionControl:{ compact:true }, renderWorldCopies:true, fadeDuration:150,
        // Auf dem Handy wackelt der Finger: erst ab 10 px Bewegung zählt es als Verschieben statt Tippen
        clickTolerance:matchMedia('(pointer: coarse)').matches ? 10 : 3
      });
      k.touchZoomRotate.disableRotation();
      k.keyboard.disableRotation();
      k.on('click', e => { if (this.onKlick) this.onKlick(e.lngLat.lat, e.lngLat.lng); });
      // Symbole, die im Stil fehlen, durch ein leeres Bild ersetzen (sonst nur Warnungen)
      k.on('styleimagemissing', e => { if (!k.hasImage(e.id)) k.addImage(e.id, { width:1, height:1, data:new Uint8Array(4) }); });
      // Sobald der Stil da ist (nicht erst, wenn alle Kacheln geladen sind), kommen die Linien dazu
      k.once('style.load', () => {
        k.addSource('linien', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
        k.addLayer({ id:'linien', type:'line', source:'linien', paint:{ 'line-color':['get', 'farbe'], 'line-width':3, 'line-dasharray':[2, 1.6], 'line-opacity':0.9 } });
        this.bereit = true;
        this.zeichnen();
      });
      // Nadeln und Ausschnitt gehen schon vorher
      this.zeichnen();
      if (this.warteAuf){ const w = this.warteAuf; this.warteAuf = null; w(); }
      // Die Kartenbox wächst beim Überfahren bzw. wird auf dem Handy eingeblendet
      new ResizeObserver(() => k.resize()).observe(this.el);
    }
    weltZoom(){ const b = this.el.clientWidth || 300; return b > 700 ? 1.2 : b > 360 ? 0.6 : 0.2; }
    groesse(){ if (this.karte) this.karte.resize(); }
    zoomen(faktor){ if (!this.karte) return; if (faktor > 1) this.karte.zoomIn(); else this.karte.zoomOut(); }
    ganzeWelt(sofort){
      if (!this.karte) return;
      this.karte[sofort ? 'jumpTo' : 'easeTo']({ center:[10, 25], zoom:this.weltZoom() });
    }
    // Zur eigenen Nadel springen (Handy: nach dem Hineinzoomen schnell wiederfinden)
    zu(lat, lon, zoom){ if (this.karte) this.karte.easeTo({ center:[lon, lat], zoom:Math.max(this.karte.getZoom(), zoom || 0) }); }

    // marker: [{lat, lon, art:'ziel'|undefined, farbe, text, eigene}], linien: [{von, nach, farbe}]
    setzen(marker, linien){
      this.markerDaten = marker || [];
      this.linienDaten = linien || [];
      this.zeichnen();
    }
    zeichnen(){
      if (!this.karte) return;
      this.karte.resize();
      for (const m of this.marker) m.remove();
      this.marker = [];
      for (const m of this.markerDaten || []){
        const ziel = m.art === 'ziel';
        const mk = new maplibregl.Marker({
          element:ziel ? flaggeElement() : nadelElement(m.farbe || '#e8472b', m.text || ''),
          anchor:ziel ? 'bottom-left' : 'bottom', offset:ziel ? [-4, 2] : [0, 1],
          draggable:!!(m.eigene && this.ziehbar)
        }).setLngLat([m.lon, m.lat]).addTo(this.karte);
        if (m.eigene && this.ziehbar) mk.on('dragend', () => { const p = mk.getLngLat(); if (this.onKlick) this.onKlick(p.lat, p.lng); });
        if (ziel) mk.getElement().style.zIndex = 5;
        this.marker.push(mk);
      }
      if (!this.bereit) return;
      // Linien über die Datumsgrenze: Ziel auf die nächstgelegene Kopie der Welt legen
      this.karte.getSource('linien').setData({ type:'FeatureCollection', features:(this.linienDaten || []).map(li => ({
        type:'Feature', properties:{ farbe:li.farbe || '#222' },
        geometry:{ type:'LineString', coordinates:[[li.von.lon, li.von.lat], [naheLon(li.nach.lon, li.von.lon), li.nach.lat]] }
      })) });
    }
    // Ausschnitt so wählen, dass alle Punkte sichtbar sind
    passend(punkte, rand = 60, sofort = false){
      if (!this.karte){ this.warteAuf = () => this.passend(punkte, rand, true); return; }
      if (!punkte.length) return this.ganzeWelt(sofort);
      const ref = punkte[0].lon;
      const b = new maplibregl.LngLatBounds();
      for (const p of punkte) b.extend([naheLon(p.lon, ref), p.lat]);
      const pad = Math.min(rand, this.el.clientWidth / 4, this.el.clientHeight / 4);
      this.karte.fitBounds(b, { padding:pad, maxZoom:15, duration:sofort ? 0 : 900 });
    }
  }

  window.Karte = Karte;
})();
