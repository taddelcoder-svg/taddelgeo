'use strict';
// Weltkarte zum Raten: Leaflet mit OpenStreetMap-Kacheln. Die Kacheln kommen über den
// eigenen Server (/kacheln/…), der sie bei OpenStreetMap holt und zwischenspeichert –
// der Browser der Spieler verbindet sich also nie mit fremden Diensten.
(function(){
  const NACHWEIS = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende';

  const escHtml = t => String(t).replace(/[&<>"']/g, z => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[z]));
  function nadelIcon(farbe, text){
    const innen = text
      ? `<text x="14" y="15.5" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Barlow SC, system-ui, sans-serif">${escHtml(text.slice(0, 2).toUpperCase())}</text>`
      : '<circle cx="14" cy="12" r="4.2" fill="#fff"/>';
    return L.divIcon({
      className:'karten-nadel', iconSize:[28, 38], iconAnchor:[14, 37],
      html:`<svg viewBox="0 0 28 38" width="28" height="38" aria-hidden="true"><path d="M14 37C14 37 2 22 2 13a12 12 0 0 1 24 0c0 9-12 24-12 24z" fill="${farbe}" stroke="#fff" stroke-width="2.5"/>${innen}</svg>`
    });
  }
  const flaggeIcon = L.divIcon({
    className:'karten-nadel', iconSize:[30, 40], iconAnchor:[4, 38],
    html:'<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><circle cx="4" cy="36" r="3.5" fill="#16202c" stroke="#fff" stroke-width="1.5"/><path d="M4 36V3" stroke="#16202c" stroke-width="2.5"/><path d="M5 3l22 7-22 8z" fill="#20b35a" stroke="#fff" stroke-width="1.5"/></svg>'
  });

  class Karte {
    constructor(el, opt = {}){
      this.el = el;
      this.onKlick = opt.onKlick || null;
      this.karte = L.map(el, {
        zoomControl:false, worldCopyJump:true, minZoom:1, maxZoom:19,
        zoomSnap:0.25, zoomDelta:1, wheelPxPerZoomLevel:90, attributionControl:true
      });
      this.karte.attributionControl.setPrefix(false);
      L.tileLayer('/kacheln/{z}/{x}/{y}.png', { maxZoom:19, attribution:NACHWEIS, crossOrigin:false }).addTo(this.karte);
      this.ebene = L.layerGroup().addTo(this.karte);
      this.karte.on('click', e => { if (this.onKlick) this.onKlick(e.latlng.lat, e.latlng.lng); });
      this.ganzeWelt(true);
      // Die Kartenbox wächst beim Überfahren – Leaflet muss das mitbekommen
      new ResizeObserver(() => this.groesse()).observe(el);
    }
    groesse(){ this.karte.invalidateSize({ pan:false }); }
    zoomen(faktor){ if (faktor > 1) this.karte.zoomIn(); else this.karte.zoomOut(); }
    ganzeWelt(sofort){
      const b = this.el.clientWidth || 300;
      this.karte.setView([25, 10], b > 700 ? 2 : b > 360 ? 1.5 : 1, { animate:!sofort });
    }
    // marker: [{lat, lon, art:'ziel'|undefined, farbe, text}], linien: [{von, nach, farbe}]
    setzen(marker, linien){
      this.ebene.clearLayers();
      // Linien über die Datumsgrenze: Ziel auf die Kopie der Welt legen, die am nächsten liegt
      for (const li of linien || []){
        let lon = li.nach.lon;
        while (lon - li.von.lon > 180) lon -= 360;
        while (lon - li.von.lon < -180) lon += 360;
        L.polyline([[li.von.lat, li.von.lon], [li.nach.lat, lon]], { color:li.farbe || '#222', weight:3, dashArray:'8 7', opacity:0.9, interactive:false }).addTo(this.ebene);
      }
      for (const m of marker || []){
        L.marker([m.lat, m.lon], { icon:m.art === 'ziel' ? flaggeIcon : nadelIcon(m.farbe || '#e8472b', m.text || ''), interactive:false, keyboard:false, zIndexOffset:m.art === 'ziel' ? 1000 : 0 }).addTo(this.ebene);
      }
    }
    // Ausschnitt so wählen, dass alle Punkte sichtbar sind
    passend(punkte, rand = 60, sofort = false){
      if (!punkte.length) return this.ganzeWelt(sofort);
      const ref = punkte[0].lon;
      const ll = punkte.map(p => {
        let lon = p.lon;
        while (lon - ref > 180) lon -= 360;
        while (lon - ref < -180) lon += 360;
        return [p.lat, lon];
      });
      this.karte.fitBounds(L.latLngBounds(ll), { padding:[rand, rand], maxZoom:16, animate:!sofort });
    }
  }

  window.Karte = Karte;
})();
