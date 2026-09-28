'use strict';
// Olympiade-Anbindung – in allen Spielen gleich (Vorlage: olympiade/geteilt/olymp.js).
// Die Olympiade stellt jedem Spieler ein signiertes Ticket aus (im Link ?olymp=…).
// Darin steht, wer er ist, zu welcher Disziplin (Lauf) und Gruppe er gehört, wer noch
// erwartet wird und wohin das Ergebnis gemeldet wird. Signiert wird mit einem Schlüssel,
// der aus dem gemeinsamen ZUGANG_PASSWORT abgeleitet ist – so braucht es keine neue
// Einstellung auf Render, und niemand ohne Passwort kann Tickets fälschen.
const crypto = require('crypto');

function schluesselAus(passwort, aufRender){
  if (passwort) return crypto.createHash('sha256').update('olymp:' + passwort).digest();
  return aufRender ? null : Buffer.from('olymp-lokal-ohne-passwort');
}
const b64 = s => Buffer.from(s).toString('base64url');
const aus64 = s => Buffer.from(s, 'base64url').toString('utf8');

function signieren(schluessel, text){ return crypto.createHmac('sha256', schluessel).update(text).digest('base64url'); }
function gleich(a, b){
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function olymp({ spiel } = {}){
  const schluessel = schluesselAus(process.env.ZUGANG_PASSWORT || '', !!process.env.RENDER);

  // Gibt den Inhalt des Tickets zurück oder null (falsche Signatur, abgelaufen, anderes Spiel)
  function ticketPruefen(ticket){
    if (!schluessel || typeof ticket !== 'string' || ticket.length > 4000) return null;
    const [daten, sig] = ticket.split('.');
    if (!daten || !sig || !gleich(signieren(schluessel, daten), sig)) return null;
    let t;
    try { t = JSON.parse(aus64(daten)); } catch { return null; }
    if (!t || typeof t !== 'object' || !(t.bis > Date.now())) return null;
    if (spiel && t.sp !== spiel) return null;
    if (typeof t.l !== 'string' || typeof t.s !== 'string' || !Array.isArray(t.m) || typeof t.u !== 'string') return null;
    if (!/^https?:\/\/[\w.:-]+$/.test(t.u)) return null;
    t.g = Number.isInteger(t.g) ? t.g : 0;
    t.c = t.c && typeof t.c === 'object' ? t.c : {};
    t.n = String(t.n || 'Spieler').slice(0, 16);
    return t;
  }

  // Nachricht an die Olympiade schicken (mit Wiederholung, falls sie gerade aufwacht)
  async function post(t, pfad, inhalt, versuche = 4){
    if (!schluessel) return false;
    const text = JSON.stringify({ ...inhalt, lauf:t.l, gruppe:t.g, spiel:t.sp, zeit:Date.now() });
    for (let i = 0; i < versuche; i++){
      try {
        const res = await fetch(t.u + pfad, {
          method:'POST', body:text,
          headers:{ 'Content-Type':'application/json', 'X-Olymp-Signatur':signieren(schluessel, text) },
          signal:AbortSignal.timeout(15_000)
        });
        if (res.ok || res.status === 404 || res.status === 409) return res.ok;
      } catch (e) { /* gleich nochmal */ }
      await new Promise(ok => setTimeout(ok, 3000 * (i + 1)));
    }
    console.warn('Olympiade nicht erreichbar:', t.u + pfad);
    return false;
  }

  return {
    aktiv:!!schluessel,
    ticketPruefen,
    // Rangliste einer Gruppe, bester zuerst: [{ s:spielerId, text:'1:23,4' }]
    rangMelden:(t, rang) => post(t, '/api/ergebnis', { art:'rang', rang }),
    // Einzelwertung eines Spielers (höher ist besser)
    wertMelden:(t, s, wert, text) => post(t, '/api/ergebnis', { art:'wert', s, wert, text }),
    // Wer ist schon da, läuft es schon? (hält die Olympiade auch wach)
    status:(t, drin, phase) => post(t, '/api/status', { drin, phase }, 1),
    // Einzelspiele: ein Spieler hat die Disziplin geöffnet
    da:(t, s) => post(t, '/api/status', { da:s, phase:'laeuft' }, 1),
    // Zum Weiterreichen an den Browser (ohne Signatur): was die Seite anzeigen darf
    fuerBrowser:t => ({ lauf:t.l, gruppe:t.g, spieler:t.s, name:t.n, erwartet:t.m, einst:t.c, zurueck:t.z, titel:t.ti || 'Olympiade', nr:t.nr, von:t.von })
  };
};

// Auch für die Olympiade selbst: Tickets ausstellen und Meldungen prüfen
module.exports.werkzeug = function(){
  const schluessel = schluesselAus(process.env.ZUGANG_PASSWORT || '', !!process.env.RENDER);
  return {
    aktiv:!!schluessel,
    ausstellen(inhalt){ const daten = b64(JSON.stringify(inhalt)); return daten + '.' + signieren(schluessel, daten); },
    meldungOk(text, sig){ return !!schluessel && typeof sig === 'string' && gleich(signieren(schluessel, text), sig); }
  };
};
