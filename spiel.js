'use strict';
// Weltenbummler – Spiel im Browser: Panorama-Anzeige (three.js), Ratekarte, Verbindung zum Server.
(function(){
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, z => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[z]));
  const zahlFmt = new Intl.NumberFormat('de-DE');
  const speicher = {
    lesen(k, std){ try { const v = localStorage.getItem(k); return v == null ? std : JSON.parse(v); } catch { return std; } },
    schreiben(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    sitzungLesen(k){ try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
    sitzungSchreiben(k, v){ try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const FARBEN = ['#e8472b', '#1f6fd1', '#d98a00', '#8e44ad', '#16a085', '#d6336c', '#2f9e44', '#5c7cfa', '#e67700', '#0b7285', '#a61e4d', '#495057'];

  function entfernungText(km){
    if (km == null) return '–';
    if (km < 1) return zahlFmt.format(Math.round(km * 1000)) + ' m';
    if (km < 10) return km.toFixed(1).replace('.', ',') + ' km';
    return zahlFmt.format(Math.round(km)) + ' km';
  }
  function meldung(text, ms = 3000){
    const m = $('#meldung');
    m.textContent = text; m.hidden = false;
    clearTimeout(meldung.t);
    meldung.t = setTimeout(() => { m.hidden = true; }, ms);
  }

  /* ================= Panorama-Anzeige ================= */
  const pano = (() => {
    const flaeche = $('#panoFlaeche');
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas:flaeche, antialias:true, powerPreference:'high-performance' });
    } catch (e){
      return { strecke(){ meldung('Dein Browser kann leider kein WebGL – das Panorama lässt sich nicht anzeigen.', 8000); }, zumStart(){}, zoom(){}, norden(){} };
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    const szene = new THREE.Scene();
    const kamera = new THREE.PerspectiveCamera(80, 1, 0.1, 1100);
    const kugelGeo = new THREE.SphereGeometry(500, 72, 48);
    kugelGeo.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color:0x111820 });
    szene.add(new THREE.Mesh(kugelGeo, material));
    // Zweite, etwas kleinere Kugel für den Überblend-Effekt beim Weitergehen
    const blendGeo = new THREE.SphereGeometry(450, 72, 48);
    blendGeo.scale(-1, 1, 1);
    const blendMat = new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false, depthTest:false });
    const blendKugel = new THREE.Mesh(blendGeo, blendMat);
    blendKugel.visible = false;
    szene.add(blendKugel);
    const lader = new THREE.TextureLoader();

    // Die Bildmitte eines Panoramas zeigt in Himmelsrichtung h (0 = Norden, 90 = Osten).
    // "blick" ist die Himmelsrichtung, in die man gerade schaut – sie bleibt beim Weitergehen gleich.
    let graph = null, idx = 0, h = 0, blick = 0, neigung = 0, fov = 80, startBlick = 0;
    let vBlick = 0, vNeig = 0, zieht = false, schmutzig = true, laedt = false, blend = null, onSchritt = null;
    const zeiger = new Map();
    let pinch = null, letzte = null, druck = null;
    const rad = THREE.MathUtils.degToRad;
    const lonVon = b => 180 + b - h;   // Himmelsrichtung -> Winkel in der Szene

    /* ---- Pfeile am Boden ---- */
    const pfeile = new THREE.Group();
    szene.add(pfeile);
    const pfeilForm = new THREE.Shape();
    pfeilForm.moveTo(0.55, 0); pfeilForm.lineTo(-0.25, 0.5); pfeilForm.lineTo(-0.05, 0); pfeilForm.lineTo(-0.25, -0.5); pfeilForm.closePath();
    const pfeilGeo = new THREE.ShapeGeometry(pfeilForm);
    pfeilGeo.rotateX(-Math.PI / 2);
    const trefferGeo = new THREE.CircleGeometry(0.75, 20);
    trefferGeo.rotateX(-Math.PI / 2);
    const matPfeil = () => new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.92, depthTest:false, side:THREE.DoubleSide });
    const matSchatten = new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.35, depthTest:false, side:THREE.DoubleSide });
    const matTreffer = new THREE.MeshBasicMaterial({ visible:false, side:THREE.DoubleSide });
    let treffer = [], hover = null;

    function pfeileBauen(){
      for (const c of pfeile.children) c.traverse(o => { if (o.material && o.material !== matSchatten && o.material !== matTreffer) o.material.dispose(); });
      pfeile.clear(); treffer = []; hover = null;
      if (!graph) return;
      for (const [ziel, peil] of graph.knoten[idx].n){
        const w = rad(lonVon(peil));
        const g = new THREE.Group();
        g.position.set(Math.cos(w) * 2.6, -1.45, Math.sin(w) * 2.6);
        g.rotation.y = -w;
        const schatten = new THREE.Mesh(pfeilGeo, matSchatten);
        schatten.position.set(0.04, -0.03, 0); schatten.scale.setScalar(1.12); schatten.renderOrder = 1;
        const pfeil = new THREE.Mesh(pfeilGeo, matPfeil()); pfeil.renderOrder = 2;
        const t = new THREE.Mesh(trefferGeo, matTreffer); t.userData.ziel = ziel; t.userData.pfeil = pfeil;
        g.add(schatten, pfeil, t);
        pfeile.add(g); treffer.push(t);
      }
      schmutzig = true;
    }

    function groesse(){
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      kamera.aspect = window.innerWidth / window.innerHeight;
      kamera.updateProjectionMatrix();
      schmutzig = true;
    }
    window.addEventListener('resize', groesse);
    groesse();

    const nadel = $('#kompassNadel');
    function zeichnen(){
      neigung = Math.max(-85, Math.min(85, neigung));
      blick = ((blick % 360) + 360) % 360;
      const phi = rad(90 - neigung), theta = rad(lonVon(blick));
      kamera.fov = fov; kamera.updateProjectionMatrix();
      kamera.lookAt(500 * Math.sin(phi) * Math.cos(theta), 500 * Math.cos(phi), 500 * Math.sin(phi) * Math.sin(theta));
      renderer.render(szene, kamera);
      if (nadel) nadel.style.transform = `rotate(${-blick}deg)`;
    }
    function schleife(t){
      if (!zieht && (Math.abs(vBlick) > 0.01 || Math.abs(vNeig) > 0.01)){
        blick += vBlick; neigung += vNeig; vBlick *= 0.92; vNeig *= 0.92; schmutzig = true;
      }
      if (blend){
        const f = Math.min(1, (t - blend.t0) / 380);
        blendMat.opacity = 1 - f;
        // leichtes "Hineinlaufen": die alte Kugel rückt entgegen der Laufrichtung weg
        blendKugel.position.set(-blend.dx * f * 140, 0, -blend.dz * f * 140);
        if (f >= 1){ blendKugel.visible = false; if (blendMat.map){ blendMat.map.dispose(); blendMat.map = null; } blend = null; }
        schmutzig = true;
      }
      if (schmutzig){ schmutzig = false; zeichnen(); }
      requestAnimationFrame(schleife);
    }
    requestAnimationFrame(schleife);

    /* ---- Laden und Weitergehen ---- */
    const url = i => `/panos/${graph.knoten[i].id}.jpg`;
    function vorladen(){
      // Nachbarbilder schon anfragen, dann kommen sie beim Klick aus dem Browser-Speicher
      for (const [n] of graph.knoten[idx].n){ const b = new Image(); b.src = url(n); }
    }
    function gehe(i, ersterSchritt){
      if (!graph || (laedt && !ersterSchritt)) return;
      laedt = true;
      const g = graph;
      const warten = setTimeout(() => { $('#laden').hidden = false; $('#laden').classList.toggle('leicht', !ersterSchritt); }, ersterSchritt ? 0 : 250);
      lader.load(url(i), tex => {
        clearTimeout(warten);
        $('#laden').hidden = true;
        laedt = false;
        if (graph !== g){ tex.dispose(); return; }
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const alt = material.map;
        if (alt && !ersterSchritt){
          // altes Bild auf der Blend-Kugel ausblenden, gedreht wie vorher
          if (blendMat.map) blendMat.map.dispose();
          blendMat.map = alt; blendMat.opacity = 1; blendMat.needsUpdate = true;
          const hNeu = graph.knoten[i].h;
          blendKugel.rotation.y = rad(hNeu - h);
          const kante = graph.knoten[idx].n.find(([n]) => n === i);
          const w = rad(180 + (kante ? kante[1] : blick) - hNeu);
          blendKugel.position.set(0, 0, 0); blendKugel.visible = true;
          blend = { t0:performance.now(), dx:Math.cos(w), dz:Math.sin(w) };
        } else if (alt) alt.dispose();
        material.map = tex; material.color.set(0xffffff); material.needsUpdate = true;
        idx = i; h = graph.knoten[i].h;
        if (ersterSchritt){ blick = startBlick; neigung = 0; fov = window.innerWidth < window.innerHeight ? 95 : 80; vBlick = vNeig = 0; }
        pfeileBauen();
        vorladen();
        if (!ersterSchritt && onSchritt) onSchritt(i);
        schmutzig = true;
      }, undefined, () => {
        clearTimeout(warten);
        laedt = false;
        $('#laden').hidden = true;
        meldung('Das Panorama konnte nicht geladen werden. Prüf deine Verbindung.', 6000);
      });
    }
    const winkel = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    // Nachbarn in einer Richtung suchen (für Tastatur und Klick auf den Boden)
    function nachbarIn(richtung, max){
      let best = null, bd = max;
      for (const [n, p] of graph.knoten[idx].n){ const d = winkel(p, richtung); if (d < bd){ bd = d; best = n; } }
      return best;
    }

    /* ---- Steuerung ---- */
    const el = $('#pano');
    const grad = () => fov / window.innerHeight;
    const strahl = new THREE.Raycaster(), maus = new THREE.Vector2();
    function zielUnter(x, y){
      maus.set(x / window.innerWidth * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      strahl.setFromCamera(maus, kamera);
      const t = strahl.intersectObjects(treffer, false)[0];
      return { pfeil:t ? t.object : null, richtung:strahl.ray.direction };
    }
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      zeiger.set(e.pointerId, { x:e.clientX, y:e.clientY });
      vBlick = vNeig = 0; zieht = true;
      letzte = { x:e.clientX, y:e.clientY, t:performance.now() };
      druck = { x:e.clientX, y:e.clientY, t:performance.now() };
      if (zeiger.size === 2){ const [a, b] = [...zeiger.values()]; pinch = { d:Math.hypot(a.x - b.x, a.y - b.y), fov }; druck = null; }
    });
    el.addEventListener('pointermove', e => {
      if (!zeiger.has(e.pointerId)){
        // Maus schwebt: Pfeil hervorheben
        if (e.pointerType !== 'mouse' || !treffer.length) return;
        const { pfeil } = zielUnter(e.clientX, e.clientY);
        if (pfeil !== hover){
          if (hover) hover.userData.pfeil.material.color.set(0xffffff);
          hover = pfeil;
          if (hover) hover.userData.pfeil.material.color.set(0xffd34d);
          el.style.cursor = hover ? 'pointer' : '';
          schmutzig = true;
        }
        return;
      }
      zeiger.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (zeiger.size >= 2 && pinch){
        const [a, b] = [...zeiger.values()];
        fov = Math.max(25, Math.min(100, pinch.fov * pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))));
        schmutzig = true; return;
      }
      if (!letzte) return;
      const dx = e.clientX - letzte.x, dy = e.clientY - letzte.y;
      const jetzt = performance.now(), dt = Math.max(1, jetzt - letzte.t);
      blick -= dx * grad(); neigung += dy * grad();
      vBlick = -dx * grad() * Math.min(1, 16 / dt); vNeig = dy * grad() * Math.min(1, 16 / dt);
      letzte = { x:e.clientX, y:e.clientY, t:jetzt };
      if (druck && Math.hypot(e.clientX - druck.x, e.clientY - druck.y) > 6) druck = null;
      schmutzig = true;
    });
    const ende = e => {
      const warDruck = druck && e.type === 'pointerup' && zeiger.size === 1 && performance.now() - druck.t < 600;
      zeiger.delete(e.pointerId);
      if (zeiger.size < 2) pinch = null;
      if (zeiger.size === 1){ const p = [...zeiger.values()][0]; letzte = { ...p, t:performance.now() }; return; }
      if (!zeiger.size){ zieht = false; letzte = null; }
      if (warDruck && graph){
        druck = null; vBlick = vNeig = 0;
        const { pfeil, richtung } = zielUnter(e.clientX, e.clientY);
        if (pfeil) return gehe(pfeil.userData.ziel);
        // Klick auf den Boden: in diese Richtung gehen, wenn es dort weitergeht
        if (richtung.y < -0.12){
          const lon = Math.atan2(richtung.z, richtung.x) * 180 / Math.PI;
          const n = nachbarIn(lon - 180 + h, 40);
          if (n != null) gehe(n);
        }
      }
      druck = null;
    };
    el.addEventListener('pointerup', ende);
    el.addEventListener('pointercancel', ende);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      fov = Math.max(25, Math.min(100, fov * Math.exp(e.deltaY * 0.0012)));
      schmutzig = true;
    }, { passive:false });
    window.addEventListener('keydown', e => {
      if ($('#hud').hidden || document.activeElement !== document.body || !graph) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'ArrowLeft' || k === 'a'){ blick -= 6; schmutzig = true; e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd'){ blick += 6; schmutzig = true; e.preventDefault(); }
      else if (k === 'ArrowUp' || k === 'w'){ const n = nachbarIn(blick, 70); if (n != null) gehe(n); e.preventDefault(); }
      else if (k === 'ArrowDown' || k === 's'){ const n = nachbarIn(blick + 180, 70); if (n != null) gehe(n); e.preventDefault(); }
      else if (k === '+'){ fov = Math.max(25, fov / 1.15); schmutzig = true; }
      else if (k === '-'){ fov = Math.min(100, fov * 1.15); schmutzig = true; }
    });

    return {
      // Neue Runde: Weg-Graph übernehmen und am Start beginnen
      strecke(g, blickStart, beiSchritt){
        graph = g; onSchritt = beiSchritt || null;
        startBlick = blickStart || 0;
        pfeile.clear(); treffer = [];
        gehe(g.start, true);
      },
      zumStart(){
        if (!graph) return;
        if (idx !== graph.start) gehe(graph.start);
        blick = startBlick; neigung = 0; vBlick = vNeig = 0; schmutzig = true;
      },
      norden(){ blick = 0; neigung = 0; vBlick = vNeig = 0; schmutzig = true; },
      // zum Testen: wo liegen die Pfeile auf dem Bildschirm, wo stehen wir
      pfeileAufSchirm(){
        kamera.updateMatrixWorld();
        return treffer.map(t => { const v = new THREE.Vector3(); t.getWorldPosition(v); v.project(kamera);
          return { ziel:t.userData.ziel, x:Math.round((v.x + 1) / 2 * window.innerWidth), y:Math.round((1 - v.y) / 2 * window.innerHeight), sichtbar:v.z < 1 }; });
      },
      stand(){ return { idx, h, blick:Math.round(blick), neigung:Math.round(neigung) }; },
      blickSetzen(b, n){ blick = b; neigung = n || 0; vBlick = vNeig = 0; schmutzig = true; },
      nachbarn(){ return graph ? graph.knoten[idx].n : []; },
      trefferBei(x, y){ const t = zielUnter(x, y); return { pfeil:t.pfeil ? t.pfeil.userData.ziel : null, laedt }; },
      zoom(f){ fov = Math.max(25, Math.min(100, fov * f)); schmutzig = true; }
    };
  })();

  /* ================= Zustand ================= */
  const z = {
    ws:null, verbunden:false, regionen:[], raum:null, du:null,
    runde:null, tipp:null, abgegeben:false, endeZeit:0, aufloesung:null, ende:null,
    soloEinst:{ runden:5, zeit:0, region:'welt', bewegen:true, ...speicher.lesen('wb-solo', {}) },
    sitzung:speicher.sitzungLesen('wb-sitzung'),
    kartenStufe:speicher.lesen('wb-kartenstufe', 1)
  };
  window.weltenbummler = z;   // zum Nachsehen in der Konsole

  // Olympiade: Mit ?olymp=… im Link geht es direkt in den Raum der Disziplin (Ticket prüft der Server)
  const olympia = (() => {
    let ticket = new URLSearchParams(location.search).get('olymp');
    try {
      if (ticket) sessionStorage.setItem('wb-olymp', ticket);
      else ticket = sessionStorage.getItem('wb-olymp');
    } catch {}
    if (!ticket) return null;
    history.replaceState(null, '', '/');
    return { ticket, info:null, startBis:0 };
  })();
  z.olympia = olympia;
  if (olympia) z.sitzung = null;
  function olympiaBeenden(){ try { sessionStorage.removeItem('wb-olymp'); } catch {} }
  function zurOlympiade(){
    const ziel = olympia && olympia.info && olympia.info.zurueck;
    olympiaBeenden();
    if (ziel) location.href = ziel; else location.href = '/';
  }
  z.pano = pano;

  /* ================= Verbindung ================= */
  let wartezeit = 500, warteschlange = [];
  function verbinden(){
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    z.ws = ws;
    ws.onopen = () => {
      z.verbunden = true; wartezeit = 500;
      if (olympia) z.ws.send(JSON.stringify({ t:'olymp', ticket:olympia.ticket }));
      else if (z.sitzung) senden({ t:'beitreten', code:z.sitzung.code, token:z.sitzung.token, name:name() });
      for (const m of warteschlange.splice(0)) senden(m);
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } empfangen(m); };
    ws.onclose = () => {
      z.verbunden = false;
      setTimeout(verbinden, wartezeit);
      wartezeit = Math.min(8000, wartezeit * 2);
    };
  }
  function senden(m){
    if (z.ws && z.ws.readyState === 1) z.ws.send(JSON.stringify(m));
    else warteschlange.push(m);
  }
  const name = () => ($('#name').value.trim() || 'Gast').slice(0, 16);

  function empfangen(m){
    switch (m.t){
      case 'hallo':
        z.regionen = m.regionen;
        $('#ortAnzahl').textContent = `${zahlFmt.format(m.anzahl)} Orte auf ${m.regionen.length > 1 ? 'allen Kontinenten' : 'der Welt'}`;
        einstZeichnen();
        break;
      case 'drin':
        z.sitzung = { code:m.code, token:m.token };
        if (!olympia) speicher.sitzungSchreiben('wb-sitzung', z.sitzung);
        z.du = m.id;
        break;
      case 'raum':
        z.raum = m; z.du = m.du;
        if (m.regionen) z.regionen = m.regionen;
        if (olympia && m.olymp){ olympia.info = m.olymp; olympia.startBis = m.olymp.startIn != null ? Date.now() + m.olymp.startIn : 0; }
        raumAnzeigen();
        break;
      case 'runde': rundeBeginnen(m); break;
      case 'aufloesung': aufloesungZeigen(m); break;
      case 'ende': z.ende = m; if (z.aufloesung && z.aufloesung.letzte) ergebnisKnoepfe(); break;
      case 'fehler':
        if (m.code === 'olymp' && olympia){
          olympiaBeenden();
          history.replaceState(null, '', '/');
          setTimeout(() => location.reload(), 4000);
        }
        if (m.code === 'kein-raum' && z.sitzung){
          z.sitzung = null; speicher.sitzungSchreiben('wb-sitzung', null);
          schirm('start');
        }
        fehlerZeigen(m.text);
        break;
    }
  }
  function fehlerZeigen(t){
    if ($('#start').classList.contains('aktiv')){ const f = $('#startFehler'); f.textContent = t; f.hidden = false; }
    else meldung(t, 5000);
  }

  /* ================= Schirme ================= */
  function schirm(welcher){
    for (const s of ['start', 'lobby', 'ergebnis']) $('#' + s).classList.toggle('aktiv', s === welcher);
    $('#hud').hidden = welcher !== 'hud';
    if (welcher === 'ergebnis') setTimeout(() => grosskarte && grosskarte.groesse(), 0);
    if (welcher === 'hud') setTimeout(() => minikarte && minikarte.groesse(), 0);
  }
  function zumMenue(){
    if (olympia){ senden({ t:'verlassen' }); zurOlympiade(); return; }
    senden({ t:'verlassen' });
    z.sitzung = null; z.raum = null; z.runde = null; z.aufloesung = null; z.ende = null;
    speicher.sitzungSchreiben('wb-sitzung', null);
    clearInterval(uhrTimer);
    history.replaceState(null, '', '/');
    schirm('start');
  }

  /* ================= Einstellungen ================= */
  const RUNDEN = [3, 5, 10];
  const ZEITEN = [[0, 'Ohne'], [180, '3 Min'], [120, '2 Min'], [60, '1 Min'], [30, '30 s']];
  function segment(titel, werte, aktuell, onWahl, gesperrt){
    const g = document.createElement('div');
    g.className = 'einst-gruppe';
    g.innerHTML = `<span class="titel">${esc(titel)}</span><div class="segment"></div>`;
    const seg = g.querySelector('.segment');
    for (const [wert, text] of werte){
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text;
      b.setAttribute('aria-pressed', String(wert === aktuell));
      b.disabled = !!gesperrt;
      b.onclick = () => onWahl(wert);
      seg.appendChild(b);
    }
    return g;
  }
  function einstBauen(ziel, einst, aendern, gesperrt){
    ziel.innerHTML = '';
    const regionen = z.regionen.length ? z.regionen : [{ id:'welt', name:'Ganze Welt' }];
    ziel.append(
      segment('Region', regionen.map(r => [r.id, r.name]), einst.region, v => aendern({ ...einst, region:v }), gesperrt),
      segment('Runden', RUNDEN.map(n => [n, String(n)]), einst.runden, v => aendern({ ...einst, runden:v }), gesperrt),
      segment('Zeit pro Runde', ZEITEN, einst.zeit, v => aendern({ ...einst, zeit:v }), gesperrt),
      segment('Bewegen', [[true, 'Erlaubt'], [false, 'Nur umschauen']], einst.bewegen !== false, v => aendern({ ...einst, bewegen:v }), gesperrt)
    );
  }
  function einstZeichnen(){
    einstBauen($('#soloEinst'), z.soloEinst, e => { z.soloEinst = e; speicher.schreiben('wb-solo', e); einstZeichnen(); });
    if (z.raum && !z.raum.privat) raumAnzeigen();
  }

  /* ================= Start & Warteraum ================= */
  $('#name').value = speicher.lesen('wb-name', '');
  $('#name').addEventListener('change', () => speicher.schreiben('wb-name', name()));
  $('#soloStart').onclick = () => {
    speicher.schreiben('wb-name', name());
    $('#startFehler').hidden = true;
    senden({ t:'erstellen', privat:true, name:name(), einst:z.soloEinst });
  };
  $('#partyNeu').onclick = () => {
    speicher.schreiben('wb-name', name());
    $('#startFehler').hidden = true;
    senden({ t:'erstellen', privat:false, name:name(), einst:z.soloEinst });
  };
  $('#beitretenForm').onsubmit = e => {
    e.preventDefault();
    const code = $('#code').value.trim().toUpperCase();
    if (code.length !== 4) return fehlerZeigen('Der Code hat vier Zeichen.');
    speicher.schreiben('wb-name', name());
    $('#startFehler').hidden = true;
    senden({ t:'beitreten', code, name:name() });
  };
  $('#code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  for (const b of $$('[data-menue]')) b.onclick = zumMenue;
  $('#linkKopieren').onclick = async () => {
    try { await navigator.clipboard.writeText($('#lobbyLink').value); meldung('Link kopiert – schick ihn deinen Freunden.'); }
    catch { $('#lobbyLink').select(); meldung('Markiert – jetzt kopieren.'); }
  };
  $('#partyStart').onclick = () => senden({ t:'start' });

  function raumAnzeigen(){
    const r = z.raum;
    if (!r) return;
    const istHost = r.host === z.du;
    if (r.phase === 'lobby' && !r.privat){
      schirm('lobby');
      if (!r.olymp) history.replaceState(null, '', '/?raum=' + r.code);
      $('#lobbyCode').textContent = r.code;
      $('#lobbyLink').value = location.origin + '/?raum=' + r.code;
      $('#lobbySpieler').innerHTML = r.spieler.map(s => `<li class="${s.id === z.du ? 'du' : ''}">${esc(s.name)}${s.id === r.host ? '<span class="krone" title="Gastgeber">👑</span>' : ''}${s.id === z.du ? ' (du)' : ''}</li>`).join('');
      einstBauen($('#partyEinst'), r.einst, e => senden({ t:'einst', einst:e }), !istHost);
      $('#partyStart').hidden = !istHost;
      $('#lobbyHinweis').textContent = istHost
        ? (r.spieler.length < 2 ? 'Warte auf Mitspieler – oder starte schon mal allein.' : 'Alle da? Dann los!')
        : 'Der Gastgeber stellt ein und startet das Spiel.';
      $('#olympBanner').hidden = !r.olymp; $('#raumKopf').hidden = !!r.olymp;
      $('#lobby .zurueck').textContent = r.olymp ? '← Zurück zur Olympiade' : '← Hauptmenü';
      if (r.olymp){
        const o = r.olymp;
        $('#olympBanner').innerHTML = `🏅 <b>${esc(o.titel)}</b> · Disziplin ${o.nr} von ${o.von}<div class="erwartet">${o.erwartet.map(e => `<span class="${e.da ? 'da' : ''}">${e.da ? '✓' : '…'} ${esc(e.n)}</span>`).join('')}</div>`;
        einstBauen($('#partyEinst'), r.einst, () => {}, true);
        $('#partyStart').hidden = !istHost || o.gestartet;
        $('#partyStart').textContent = 'Ohne die anderen starten';
        olympHinweis();
      }
    }
    // Mitspieler-Anzeige im HUD
    if (!r.privat && r.phase === 'runde'){
      $('#hudSpieler').innerHTML = r.spieler.map(s => `<li class="${s.geraten ? 'fertig' : ''} ${s.weg ? 'weg' : ''}">${esc(s.name)}</li>`).join('');
    } else $('#hudSpieler').innerHTML = '';
    const ich = r.spieler.find(s => s.id === z.du);
    if (ich && r.phase === 'runde') $('#hudPunkte').textContent = zahlFmt.format(ich.punkte);
    if (z.aufloesung && (r.phase === 'aufloesung' || r.phase === 'ende')) ergebnisKnoepfe();
  }

  /* ================= Runde ================= */
  let minikarte = null, grosskarte = null, uhrTimer = null;
  z.karten = () => ({ minikarte, grosskarte });   // zum Testen

  const kartenStufen = [[280, 190, 480, 340], [360, 240, 620, 440], [460, 320, 760, 540]];
  function kartenGroesse(){
    const [kb, kh, gb, gh] = kartenStufen[z.kartenStufe] || kartenStufen[1];
    const box = $('#rateBox');
    const maxB = window.innerWidth - 90, maxH = window.innerHeight - 170;
    box.style.setProperty('--kb', Math.min(kb, maxB) + 'px');
    box.style.setProperty('--kh', Math.min(kh, maxH) + 'px');
    box.style.setProperty('--kb-gross', Math.min(gb, maxB) + 'px');
    box.style.setProperty('--kh-gross', Math.min(gh, maxH) + 'px');
  }
  window.addEventListener('resize', kartenGroesse);
  for (const b of $$('[data-groesse]')) b.onclick = () => {
    z.kartenStufe = Math.max(0, Math.min(2, z.kartenStufe + Number(b.dataset.groesse)));
    speicher.schreiben('wb-kartenstufe', z.kartenStufe);
    kartenGroesse();
  };
  for (const b of $$('[data-kzoom]')) b.onclick = () => minikarte && minikarte.zoomen(Number(b.dataset.kzoom));
  $('#karteAuf').onclick = () => { $('#rateBox').classList.add('offen'); minikarte && minikarte.groesse(); };
  $('#kKarteZu').onclick = () => $('#rateBox').classList.remove('offen');
  $('#kZuTipp').onclick = () => { if (minikarte && z.tipp) minikarte.zu(z.tipp.lat, z.tipp.lon, 5); };
  $('#kWelt').onclick = () => minikarte && minikarte.ganzeWelt(false);
  $('#blickZurueck').onclick = () => pano.zumStart();
  $('#kompass').onclick = () => pano.norden();
  $('#panoPlus').onclick = () => pano.zoom(1 / 1.25);
  $('#panoMinus').onclick = () => pano.zoom(1.25);
  $('#verlassen').onclick = () => { if (confirm('Spiel wirklich verlassen?')) zumMenue(); };
  // Leertaste oder Enter = Raten
  window.addEventListener('keydown', e => {
    if ((e.key === ' ' || e.key === 'Enter') && !$('#hud').hidden && document.activeElement === document.body && z.tipp && !z.abgegeben){ e.preventDefault(); raten(); }
    else if ((e.key === ' ' || e.key === 'Enter') && $('#ergebnis').classList.contains('aktiv') && document.activeElement === document.body){
      const b = $('#ergebnisKarte .knopf:not(:disabled)'); if (b){ e.preventDefault(); b.click(); }
    }
  });

  async function rundeBeginnen(m){
    z.runde = m; z.aufloesung = null; z.ende = null;
    z.tipp = null; z.abgegeben = !!m.schonGeraten;
    schirm('hud');
    kartenGroesse();
    $('#rateBox').classList.remove('offen');
    if (!minikarte){
      minikarte = new Karte($('#minikarte'), { ziehbar:true, onKlick:(lat, lon) => {
        if (z.abgegeben) return;
        z.tipp = { lat, lon };
        minikarte.setzen([{ lat, lon, farbe:FARBEN[0], eigene:true }]);
        $('#kZuTipp').hidden = false;
        $('#kartenHinweis').textContent = 'Nadel ziehen oder neu tippen zum Korrigieren';
        $('#karteAuf').textContent = '🗺️ Tipp ändern';
        const b = $('#raten'); b.disabled = false; b.textContent = 'Raten';
      } });
    } else minikarte.groesse();
    minikarte.setzen([]);
    minikarte.ganzeWelt(true);
    $('#kZuTipp').hidden = true;
    $('#kartenHinweis').textContent = 'Tippe auf die Karte, um deinen Tipp zu setzen';
    $('#karteAuf').textContent = '🗺️ Karte';
    const b = $('#raten'); b.disabled = true; b.textContent = z.abgegeben ? 'Tipp abgegeben' : 'Setz deinen Tipp auf die Karte';
    $('#wartenBox').hidden = !z.abgegeben;
    $('#hudRunde').textContent = `${m.nr}/${m.von}`;
    const ich = z.raum && z.raum.spieler.find(s => s.id === z.du);
    $('#hudPunkte').textContent = zahlFmt.format(ich ? ich.punkte : 0);
    pano.strecke(m.graph, m.blick, i => senden({ t:'hier', i }));
    if (m.graph.knoten.length > 1 && !speicher.lesen('wb-laufhinweis', false)){
      speicher.schreiben('wb-laufhinweis', true);
      meldung(matchMedia('(pointer: coarse)').matches ? 'Tipp: Tippe auf die Pfeile am Boden, um dich zu bewegen.' : 'Tipp: Klick auf die Pfeile am Boden (oder W/↑), um dich zu bewegen.', 6000);
    }
    // Uhr: die Anzeige endet 1,5 s vor dem Server (Ladepuffer), dann wird ein gesetzter Tipp abgeschickt
    clearInterval(uhrTimer);
    z.endeZeit = m.rest ? performance.now() + m.rest - 1500 : 0;
    $('#hudZeitBox').hidden = !m.rest;
    if (m.rest){
      const tick = () => {
        const rest = Math.max(0, z.endeZeit - performance.now());
        const s = Math.ceil(rest / 1000);
        $('#hudZeit').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        $('#hudZeitBox').classList.toggle('knapp', s <= 10);
        if (rest <= 0){
          clearInterval(uhrTimer);
          if (z.tipp && !z.abgegeben) raten();
        }
      };
      tick(); uhrTimer = setInterval(tick, 250);
    }
  }
  function raten(){
    if (!z.tipp || z.abgegeben) return;
    z.abgegeben = true;
    senden({ t:'tipp', lat:z.tipp.lat, lon:z.tipp.lon });
    const b = $('#raten'); b.disabled = true; b.textContent = 'Tipp abgegeben';
    $('#rateBox').classList.remove('offen');
    $('#karteAuf').textContent = '🗺️ Karte';
    if (z.raum && !z.raum.privat && z.raum.spieler.filter(s => !s.weg).length > 1) $('#wartenBox').hidden = false;
  }
  $('#raten').onclick = raten;

  /* ================= Auflösung & Ende ================= */
  function farbeVon(id){
    const liste = z.raum ? z.raum.spieler.map(s => s.id) : [];
    if (id === z.du) return FARBEN[0];
    const i = liste.filter(x => x !== z.du).indexOf(id);
    return FARBEN[1 + ((i < 0 ? 0 : i) % (FARBEN.length - 1))];
  }

  async function aufloesungZeigen(m){
    clearInterval(uhrTimer);
    z.aufloesung = m;
    $('#rateBox').classList.remove('offen');
    schirm('ergebnis');
    if (!grosskarte) grosskarte = new Karte($('#grosskarte'));
    else grosskarte.groesse();
    const marker = [{ lat:m.ziel.lat, lon:m.ziel.lon, art:'ziel' }];
    const linien = [];
    for (const t of m.tipps){
      if (t.lat == null) continue;
      marker.push({ lat:t.lat, lon:t.lon, farbe:farbeVon(t.id), text:z.raum && !z.raum.privat ? t.name : '' });
      linien.push({ von:{ lat:t.lat, lon:t.lon }, nach:m.ziel, farbe:farbeVon(t.id) });
    }
    // Ziel zuletzt zeichnen, damit die Flagge oben liegt
    marker.push(marker.shift());
    grosskarte.setzen(marker, linien);
    requestAnimationFrame(() => grosskarte.passend(marker, 70));

    const ich = m.tipps.find(t => t.id === z.du) || { punkte:0, km:null, gesamt:0 };
    const mehrere = m.tipps.length > 1;
    const lob = ich.km == null ? 'Kein Tipp abgegeben' : ich.punkte >= 4800 ? 'Unglaublich!' : ich.punkte >= 4000 ? 'Super getroffen!'
      : ich.punkte >= 2500 ? 'Gar nicht schlecht!' : ich.punkte >= 1000 ? 'Immerhin die richtige Ecke' : 'Da lagst du daneben';
    const landZeile = ich.land == null ? `Das war: <b>${esc(m.ziel.land)}</b>`
      : ich.richtigesLand ? `<span class="treffer">✓ Richtiges Land: <b>${esc(m.ziel.land)}</b></span>`
      : `Das war: <b>${esc(m.ziel.land)}</b> – dein Tipp lag in ${esc(ich.land)}`;
    const nachweis = `Foto: ${esc(m.ziel.urheber)}, ${m.ziel.lizenzUrl ? `<a href="${esc(m.ziel.lizenzUrl)}" target="_blank" rel="noopener license">${esc(m.ziel.lizenz)}</a>` : esc(m.ziel.lizenz)}, via <a href="${esc(m.ziel.seite)}" target="_blank" rel="noopener">Wikimedia Commons</a> (verkleinert)`;
    const tabelle = mehrere ? `<table class="erg-tabelle"><thead><tr><th>Spieler</th><th class="r">Entfernung</th><th class="r">Runde</th><th class="r">Gesamt</th></tr></thead><tbody>
      ${m.tipps.map(t => `<tr class="${t.id === z.du ? 'du' : ''}"><td><span class="punkt" style="background:${farbeVon(t.id)}"></span>${esc(t.name)}${t.richtigesLand ? ' ✓' : ''}</td><td class="r">${entfernungText(t.km)}</td><td class="r">${zahlFmt.format(t.punkte)}</td><td class="r">${zahlFmt.format(t.gesamt)}</td></tr>`).join('')}
      </tbody></table>` : '';
    $('#ergebnisKarte').innerHTML = `<div class="erg-innen">
      <div class="erg-kopf"><h2>${esc(lob)}</h2><span class="leise">Runde ${m.nr} von ${m.von}</span></div>
      <div class="erg-zahlen">
        <div class="zahl"><b>${entfernungText(ich.km)}</b><span>Entfernung</span></div>
        <div class="zahl"><b>${zahlFmt.format(ich.punkte)}</b><span>Punkte</span></div>
        <div class="zahl"><b>${zahlFmt.format(ich.gesamt)}</b><span>Gesamt</span></div>
      </div>
      <div class="balken"><i style="width:0"></i></div>
      <p class="land-info">${landZeile}</p>
      ${tabelle}
      <div class="erg-knoepfe" id="ergKnoepfe"></div>
      <p class="nachweis">${nachweis}</p>
    </div>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const i = $('.balken i'); if (i) i.style.width = (ich.punkte / 50) + '%'; }));
    ergebnisKnoepfe();
  }

  function ergebnisKnoepfe(){
    const box = $('#ergKnoepfe');
    if (!box || !z.aufloesung) return;
    const r = z.raum, istHost = r && r.host === z.du, privat = r && r.privat;
    if (!z.aufloesung.letzte){
      box.innerHTML = (privat || istHost)
        ? `<button class="knopf gross" id="weiterKnopf">Nächste Runde</button>${privat ? '' : '<span class="leise">Geht nach einer Minute auch von selbst weiter.</span>'}`
        : '<span class="leise">Der Gastgeber startet gleich die nächste Runde …</span>';
      const w = $('#weiterKnopf'); if (w) w.onclick = () => { w.disabled = true; senden({ t:'weiter' }); };
      return;
    }
    box.innerHTML = `<button class="knopf gross" id="endeKnopf" ${z.ende ? '' : 'disabled'}>Endergebnis ansehen</button>`;
    $('#endeKnopf').onclick = endeZeigen;
  }

  function endeZeigen(){
    const e = z.ende;
    if (!e) return;
    const r = z.raum, istHost = r && r.host === z.du, privat = r && r.privat;
    const marker = [], linien = [];
    for (const v of e.verlauf){
      const t = v.tipps.find(x => x.id === z.du);
      if (t && t.lat != null){ marker.push({ lat:t.lat, lon:t.lon, farbe:FARBEN[0] }); linien.push({ von:t, nach:v.ziel, farbe:FARBEN[0] }); }
    }
    for (const v of e.verlauf) marker.push({ lat:v.ziel.lat, lon:v.ziel.lon, art:'ziel' });
    grosskarte.setzen(marker, linien);
    grosskarte.passend(marker, 60);
    const ich = e.rangliste.find(x => x.id === z.du) || { punkte:0 };
    const anteil = ich.punkte / e.max;
    const urteil = anteil > 0.9 ? 'Weltklasse! 🌍' : anteil > 0.7 ? 'Echte Weltenbummler-Qualitäten!' : anteil > 0.45 ? 'Solide Reise!' : anteil > 0.2 ? 'Da geht noch was.' : 'Die Welt ist groß …';
    const rang = e.rangliste.length > 1 ? `<table class="erg-tabelle"><thead><tr><th>Platz</th><th>Spieler</th><th class="r">Punkte</th></tr></thead><tbody>
      ${e.rangliste.map((s, i) => `<tr class="${s.id === z.du ? 'du' : ''}"><td>${['🥇', '🥈', '🥉'][i] || i + 1 + '.'}</td><td><span class="punkt" style="background:${farbeVon(s.id)}"></span>${esc(s.name)}</td><td class="r">${zahlFmt.format(s.punkte)}</td></tr>`).join('')}
      </tbody></table>` : '';
    const runden = `<table class="erg-tabelle"><thead><tr><th>Runde</th><th>Land</th><th class="r">Entfernung</th><th class="r">Punkte</th></tr></thead><tbody>
      ${e.verlauf.map((v, i) => { const t = v.tipps.find(x => x.id === z.du) || {}; return `<tr><td>${i + 1}</td><td>${esc(v.ziel.land)}${t.richtigesLand ? ' ✓' : ''}</td><td class="r">${entfernungText(t.km)}</td><td class="r">${zahlFmt.format(t.punkte || 0)}</td></tr>`; }).join('')}
      </tbody></table>`;
    let knoepfe = '';
    if (olympia) knoepfe = '<span class="leise">Deine Punkte sind bei der Olympiade eingetragen.</span><button class="knopf gross" data-menue>Zurück zur Olympiade</button>';
    else if (privat) knoepfe = '<button class="knopf gross" id="nochmal">Nochmal spielen</button><button class="knopf zweit" data-menue>Hauptmenü</button>';
    else if (istHost) knoepfe = '<button class="knopf gross" id="nochmalParty">Nochmal spielen</button><button class="knopf zweit" id="zurLobby">Einstellungen ändern</button><button class="knopf zweit" data-menue>Raum verlassen</button>';
    else knoepfe = '<span class="leise">Der Gastgeber kann gleich eine neue Runde starten.</span><button class="knopf zweit" data-menue>Raum verlassen</button>';
    $('#ergebnisKarte').innerHTML = `<div class="erg-innen">
      <div class="erg-kopf"><h2>${esc(urteil)}</h2><span class="leise">${esc(r ? r.regionName : '')}</span></div>
      <div class="erg-zahlen">
        <div class="zahl"><b>${zahlFmt.format(ich.punkte)}</b><span>von ${zahlFmt.format(e.max)} Punkten</span></div>
      </div>
      <div class="balken"><i style="width:0"></i></div>
      ${rang}${runden}
      <div class="erg-knoepfe">${knoepfe}</div>
    </div>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { const i = $('.balken i'); if (i) i.style.width = (anteil * 100) + '%'; }));
    if (privat) speicher.schreiben('wb-bestwert', Math.max(speicher.lesen('wb-bestwert', 0), ich.punkte));
    for (const b of $$('#ergebnisKarte [data-menue]')) b.onclick = zumMenue;
    const n = $('#nochmal'); if (n) n.onclick = () => { n.disabled = true; senden({ t:'nochmal', einst:z.soloEinst }); };
    const np = $('#nochmalParty'); if (np) np.onclick = () => { np.disabled = true; senden({ t:'start' }); };
    const zl = $('#zurLobby'); if (zl) zl.onclick = () => senden({ t:'lobby' });
    z.aufloesung = null;
  }

  function olympHinweis(){
    const r = z.raum;
    if (!olympia || !r || !r.olymp || r.phase !== 'lobby') return;
    const fehlt = r.olymp.erwartet.filter(e => !e.da).length;
    $('#lobbyHinweis').textContent = olympia.startBis
      ? `Alle da! Es geht los in ${Math.max(0, Math.ceil((olympia.startBis - Date.now()) / 1000))} …`
      : `Warte auf ${fehlt} Mitspieler – es geht los, sobald alle da sind.`;
  }
  if (olympia) setInterval(olympHinweis, 250);

  /* ================= Los ================= */
  einstZeichnen();
  const raumParam = new URLSearchParams(location.search).get('raum');
  if (raumParam && !z.sitzung){
    $('#code').value = raumParam.toUpperCase().slice(0, 4);
    if (speicher.lesen('wb-name', '')) setTimeout(() => $('#beitretenForm').requestSubmit(), 0);
    else { $('#name').focus(); meldung('Gib deinen Namen ein und tipp auf „Beitreten“.', 5000); }
  }
  verbinden();
})();
