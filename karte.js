'use strict';
// Weltkarte zum Raten: Web-Mercator auf einem Canvas. Verschieben, zoomen (Mausrad,
// Zwei-Finger), antippen setzt den Tipp. Die Länder werden einmal als Path2D in
// Einheitskoordinaten (0..1) gebaut und dann nur noch per Transformation gezeichnet.
(function(){
  const MAX_LAT = 85.05;
  const projX = lon => (lon + 180) / 360;
  const projY = lat => {
    const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
    return (1 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / Math.PI) / 2;
  };
  const invLon = x => x * 360 - 180;
  const invLat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

  let geo = null;   // gemeinsam für alle Karten: { land:Path2D, grenzen:Path2D, laender:[], staedte:[] }
  function geoBauen(welt){
    if (geo) return geo;
    const land = new Path2D();
    const laender = [];
    for (const l of welt.laender){
      const p = new Path2D();
      for (const r of l.r){
        for (let i = 0; i < r.length; i += 2){
          const x = projX(r[i]), y = projY(r[i + 1]);
          if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
        }
        p.closePath();
      }
      land.addPath(p);
      laender.push({ name:l.n, x:projX(l.lx), y:projY(l.ly), lr:l.lr || 5 });
    }
    const staedte = welt.staedte.map(s => ({ name:s.n, x:projX(s.lon), y:projY(s.lat), r:s.r }));
    geo = { land, laender, staedte };
    return geo;
  }

  function farbenLesen(el){
    const cs = getComputedStyle(el);
    const f = n => cs.getPropertyValue(n).trim();
    return {
      meer:f('--karte-meer') || '#a8cfe8', land:f('--karte-land') || '#f4f0e6', grenze:f('--karte-grenze') || '#a3977f',
      netz:f('--karte-netz') || 'rgba(255,255,255,.35)', text:f('--karte-text') || '#4a4234', halo:f('--karte-halo') || 'rgba(255,255,255,.85)',
      stadt:f('--karte-stadt') || '#6b5f4c'
    };
  }

  class Karte {
    constructor(canvas, welt, opt = {}){
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.geo = geoBauen(welt);
      this.onKlick = opt.onKlick || null;
      this.cx = 0.5; this.cy = 0.42; this.skala = 0;
      this.marker = []; this.linien = [];
      this.zeiger = new Map();
      this.farben = farbenLesen(canvas);
      this.w = 1; this.h = 1; this.dpr = 1;
      this.anim = null;
      this.schmutzig = true;
      new ResizeObserver(() => this.groesse()).observe(canvas);
      this.groesse();
      this.ereignisse();
      const schleife = () => { if (this.anim) this.animSchritt(); if (this.schmutzig) this.zeichnen(); requestAnimationFrame(schleife); };
      requestAnimationFrame(schleife);
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.farben = farbenLesen(canvas); this.neu(); });
    }
    neu(){ this.schmutzig = true; }
    farbenNeu(){ this.farben = farbenLesen(this.canvas); this.neu(); }

    groesse(){
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = r.width; this.h = r.height;
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      if (!this.skala) this.skala = this.minSkala();
      this.skala = Math.max(this.minSkala(), this.skala);
      this.begrenzen();
      this.neu();
    }
    minSkala(){ return Math.max(this.w * 0.95, this.h * 1.2); }
    maxSkala(){ return 256 * Math.pow(2, 17); }
    begrenzen(){
      this.skala = Math.max(this.minSkala(), Math.min(this.maxSkala(), this.skala));
      const halbH = this.h / 2 / this.skala;
      this.cy = halbH >= 0.5 ? 0.5 : Math.max(halbH, Math.min(1 - halbH, this.cy));
      this.cx = ((this.cx % 1) + 1) % 1;
    }
    // Bildschirm <-> Einheitskoordinaten
    zuEinheit(px, py){ return { x:this.cx + (px - this.w / 2) / this.skala, y:this.cy + (py - this.h / 2) / this.skala }; }
    zuSchirm(x, y){ let dx = x - this.cx; dx -= Math.round(dx); return { x:this.w / 2 + dx * this.skala, y:this.h / 2 + (y - this.cy) * this.skala }; }
    zuGeo(px, py){ const e = this.zuEinheit(px, py); return { lat:invLat(Math.max(0, Math.min(1, e.y))), lon:invLon(((e.x % 1) + 1) % 1) }; }

    zoomUm(px, py, faktor){
      const vor = this.zuEinheit(px, py);
      this.skala *= faktor;
      this.skala = Math.max(this.minSkala(), Math.min(this.maxSkala(), this.skala));
      this.cx = vor.x - (px - this.w / 2) / this.skala;
      this.cy = vor.y - (py - this.h / 2) / this.skala;
      this.begrenzen(); this.anim = null; this.neu();
    }
    zoomen(faktor){ this.zoomUm(this.w / 2, this.h / 2, faktor); }

    ereignisse(){
      const c = this.canvas;
      c.style.touchAction = 'none';
      let start = null, gezogen = false, pinch = null;
      const pos = e => { const r = c.getBoundingClientRect(); return { x:e.clientX - r.left, y:e.clientY - r.top }; };
      c.addEventListener('pointerdown', e => {
        c.setPointerCapture(e.pointerId);
        this.zeiger.set(e.pointerId, pos(e));
        this.anim = null;
        if (this.zeiger.size === 1){ start = { ...pos(e), cx:this.cx, cy:this.cy }; gezogen = false; }
        if (this.zeiger.size === 2){
          const [a, b] = [...this.zeiger.values()];
          pinch = { d:Math.hypot(a.x - b.x, a.y - b.y), skala:this.skala, m:this.zuEinheit((a.x + b.x) / 2, (a.y + b.y) / 2) };
          gezogen = true;
        }
      });
      c.addEventListener('pointermove', e => {
        if (!this.zeiger.has(e.pointerId)) return;
        const p = pos(e);
        this.zeiger.set(e.pointerId, p);
        if (this.zeiger.size >= 2 && pinch){
          const [a, b] = [...this.zeiger.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          this.skala = Math.max(this.minSkala(), Math.min(this.maxSkala(), pinch.skala * d / Math.max(10, pinch.d)));
          this.cx = pinch.m.x - (mx - this.w / 2) / this.skala;
          this.cy = pinch.m.y - (my - this.h / 2) / this.skala;
          this.begrenzen(); this.neu();
          return;
        }
        if (!start) return;
        const dx = p.x - start.x, dy = p.y - start.y;
        if (!gezogen && Math.hypot(dx, dy) > 6) gezogen = true;
        if (gezogen){
          this.cx = start.cx - dx / this.skala;
          this.cy = start.cy - dy / this.skala;
          this.begrenzen(); this.neu();
        }
      });
      const ende = e => {
        if (!this.zeiger.has(e.pointerId)) return;
        this.zeiger.delete(e.pointerId);
        if (this.zeiger.size < 2) pinch = null;
        if (this.zeiger.size === 1){ const p = [...this.zeiger.values()][0]; start = { ...p, cx:this.cx, cy:this.cy }; return; }
        if (!this.zeiger.size){
          if (!gezogen && e.type === 'pointerup' && this.onKlick){ const p = pos(e); const g = this.zuGeo(p.x, p.y); this.onKlick(g.lat, g.lon); }
          start = null;
        }
      };
      c.addEventListener('pointerup', ende);
      c.addEventListener('pointercancel', ende);
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const p = pos(e);
        const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
        this.zoomUm(p.x, p.y, Math.exp(-d * 0.0022));
      }, { passive:false });
      c.addEventListener('dblclick', e => { const p = pos(e); this.zoomUm(p.x, p.y, 2); });
    }

    setzen(marker, linien){ this.marker = marker || []; this.linien = linien || []; this.neu(); }

    // Ausschnitt so wählen, dass alle Punkte sichtbar sind (sanft animiert)
    passend(punkte, rand = 60, sofort = false){
      if (!punkte.length) return this.ganzeWelt(sofort);
      const ref = projX(punkte[0].lon);
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const p of punkte){
        let x = projX(p.lon); x -= Math.round(x - ref);
        const y = projY(p.lat);
        minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      const bw = Math.max(maxx - minx, 1e-4), bh = Math.max(maxy - miny, 1e-4);
      let skala = Math.min((this.w - 2 * rand) / bw, (this.h - 2 * rand) / bh);
      skala = Math.min(skala, 256 * Math.pow(2, 12));
      this.fliegen((minx + maxx) / 2, (miny + maxy) / 2, skala, sofort);
    }
    ganzeWelt(sofort){ this.fliegen(0.5, 0.42, this.minSkala(), sofort); }
    fliegen(x, y, skala, sofort){
      skala = Math.max(this.minSkala(), Math.min(this.maxSkala(), skala));
      if (sofort){ this.cx = x; this.cy = y; this.skala = skala; this.begrenzen(); this.neu(); return; }
      let dx = x - this.cx; dx -= Math.round(dx);
      this.anim = { t0:performance.now(), dauer:900, von:{ x:this.cx, y:this.cy, s:Math.log(this.skala) }, nach:{ x:this.cx + dx, y, s:Math.log(skala) } };
    }
    animSchritt(){
      const a = this.anim;
      let t = Math.min(1, (performance.now() - a.t0) / a.dauer);
      t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.cx = a.von.x + (a.nach.x - a.von.x) * t;
      this.cy = a.von.y + (a.nach.y - a.von.y) * t;
      this.skala = Math.exp(a.von.s + (a.nach.s - a.von.s) * t);
      this.begrenzen();
      if (t >= 1) this.anim = null;
      this.neu();
    }

    zeichnen(){
      this.schmutzig = false;
      const { ctx, w, h, dpr, skala, farben:f } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = f.meer;
      ctx.fillRect(0, 0, w, h);
      const links = this.cx - w / 2 / skala, rechts = this.cx + w / 2 / skala;
      const zoom = Math.log2(skala / 256);

      for (let k = Math.floor(links); k <= Math.floor(rechts); k++){
        const ox = (w / 2 - (this.cx - k) * skala) * dpr, oy = (h / 2 - this.cy * skala) * dpr;
        ctx.setTransform(skala * dpr, 0, 0, skala * dpr, ox, oy);
        // Gradnetz alle 30° (bei viel Zoom alle 10°)
        ctx.strokeStyle = f.netz; ctx.lineWidth = 1 / skala;
        ctx.beginPath();
        const schritt = zoom > 4 ? 10 : 30;
        for (let lon = -180; lon <= 180; lon += schritt){ const x = projX(lon); ctx.moveTo(x, 0); ctx.lineTo(x, 1); }
        for (let lat = -80; lat <= 80; lat += schritt){ const y = projY(lat); ctx.moveTo(0, y); ctx.lineTo(1, y); }
        ctx.stroke();
        ctx.fillStyle = f.land;
        ctx.fill(this.geo.land, 'evenodd');
        ctx.strokeStyle = f.grenze; ctx.lineWidth = (zoom > 5 ? 1.2 : 0.8) / skala; ctx.lineJoin = 'round';
        ctx.stroke(this.geo.land);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Beschriftung: Ländernamen je nach Zoomstufe, große Städte erst weiter drin
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const schrift = getComputedStyle(this.canvas).fontFamily || 'sans-serif';
      if (w > 260){
        const belegt = [];
        const frei = (x, y, bw, bh) => {
          for (const b of belegt) if (Math.abs(b.x - x) < (b.w + bw) / 2 && Math.abs(b.y - y) < (b.h + bh) / 2) return false;
          belegt.push({ x, y, w:bw, h:bh }); return true;
        };
        if (zoom >= 3.4){
          ctx.font = `600 ${zoom > 5 ? 13 : 12}px ${schrift}`;
          for (const s of this.geo.staedte){
            if (s.r > (zoom - 2.4) * 2.2) continue;
            const p = this.zuSchirm(s.x, s.y);
            if (p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) continue;
            const tw = ctx.measureText(s.name).width;
            if (!frei(p.x, p.y - 11, tw + 8, 16)) continue;
            ctx.fillStyle = f.stadt; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 7); ctx.fill();
            ctx.strokeStyle = f.halo; ctx.lineWidth = 3; ctx.strokeText(s.name, p.x, p.y - 11);
            ctx.fillStyle = f.stadt; ctx.fillText(s.name, p.x, p.y - 11);
          }
        }
        const gross = zoom < 3 ? 11 : zoom < 4.5 ? 12.5 : 14;
        ctx.font = `700 ${gross}px ${schrift}`;
        for (const l of this.geo.laender){
          if (l.lr > zoom + 2.2) continue;
          const p = this.zuSchirm(l.x, l.y);
          if (p.x < -60 || p.x > w + 60 || p.y < -20 || p.y > h + 20) continue;
          const name = zoom < 3.5 ? l.name.toUpperCase() : l.name;
          const tw = ctx.measureText(name).width;
          if (!frei(p.x, p.y, tw + 6, gross + 4)) continue;
          ctx.strokeStyle = f.halo; ctx.lineWidth = 3; ctx.strokeText(name, p.x, p.y);
          ctx.fillStyle = f.text; ctx.fillText(name, p.x, p.y);
        }
      }

      // Linien zwischen Tipp und Ziel (gestrichelt), dann Marker
      for (const li of this.linien){
        const a = this.zuSchirm(projX(li.von.lon), projY(li.von.lat));
        let bx = projX(li.nach.lon) - projX(li.von.lon); bx -= Math.round(bx);
        const b = { x:a.x + bx * skala, y:this.h / 2 + (projY(li.nach.lat) - this.cy) * skala };
        ctx.save();
        ctx.setLineDash([7, 6]); ctx.lineWidth = 3; ctx.strokeStyle = li.farbe || '#222';
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
      }
      for (const m of this.marker){
        const p = this.zuSchirm(projX(m.lon), projY(m.lat));
        if (m.art === 'ziel') this.flagge(p.x, p.y);
        else this.nadel(p.x, p.y, m.farbe || '#e8472b', m.text || '');
      }
    }
    nadel(x, y, farbe, text){
      const ctx = this.ctx;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      ctx.fillStyle = farbe; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x - 4, y - 8, x - 11, y - 13, x - 11, y - 21);
      ctx.arc(x, y - 21, 11, Math.PI, 0);
      ctx.bezierCurveTo(x + 11, y - 13, x + 4, y - 8, x, y);
      ctx.closePath(); ctx.fill(); ctx.shadowColor = 'transparent'; ctx.stroke();
      if (text){
        ctx.fillStyle = '#fff'; ctx.font = `800 11px ${getComputedStyle(this.canvas).fontFamily}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text.slice(0, 2).toUpperCase(), x, y - 21);
      } else { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y - 21, 4, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    flagge(x, y){
      const ctx = this.ctx;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 5;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#16202c'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      ctx.strokeStyle = '#16202c'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 34); ctx.stroke();
      ctx.fillStyle = '#20b35a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + 1, y - 34); ctx.lineTo(x + 24, y - 27); ctx.lineTo(x + 1, y - 19); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  window.Karte = Karte;
  window.kartenProjektion = { projX, projY, invLat, invLon };
})();
