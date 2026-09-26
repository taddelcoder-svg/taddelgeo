'use strict';
// Zugangsschutz: ein gemeinsames Passwort für Familie und Freunde.
// Das Passwort steht in der Umgebungsvariable ZUGANG_PASSWORT. Wer es einmal
// eingibt, bekommt ein Cookie (technisch notwendig, daher ohne Einwilligung
// zulässig) und bleibt ein Jahr angemeldet. Die Datenschutzseite bleibt offen.
const crypto = require('crypto');

module.exports = function zugang({ titel, offen = [] }){
  const passwort = process.env.ZUGANG_PASSWORT || '';
  const aufRender = !!process.env.RENDER;
  if (!passwort) console.warn(aufRender
    ? 'ZUGANG_PASSWORT fehlt – die Seite bleibt gesperrt, bis es gesetzt ist.'
    : 'ZUGANG_PASSWORT fehlt – lokal ohne Passwortschutz.');

  const schluessel = passwort ? crypto.createHash('sha256').update('zugang:' + passwort).digest('hex') : '';
  const offenePfade = new Set(['/datenschutz', '/datenschutz.html', '/healthz', ...offen]);

  function cookieWert(req){
    const m = /(?:^|;\s*)zugang=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return m ? m[1] : '';
  }
  function hatZugang(req){
    if (!passwort) return !aufRender;
    const c = cookieWert(req);
    return c.length === 64 && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(schluessel));
  }

  // Fehlversuche je IP begrenzen (nur im Arbeitsspeicher, nach 15 Minuten vergessen)
  const versuche = new Map();
  setInterval(() => { const j = Date.now(); for (const [k, v] of versuche) if (j > v.bis) versuche.delete(k); }, 60_000).unref();
  const ipAus = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const esc = t => String(t).replace(/[&<>"]/g, z => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[z]));
  function seite(res, status, hinweis){
    res.writeHead(status, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
    res.end(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titel)} – Zugang</title>
<style>
  :root{--bg:#f4f6f8;--karte:#fff;--text:#16202c;--leise:#5a6878;--akzent:#1553a8;--rand:#d5dce4;--fehler:#b3261e}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0e141c;--karte:#18212c;--text:#eef2f6;--leise:#9aa8b8;--akzent:#7fb0ff;--rand:#2b3744;--fehler:#ff8a80}}
  :root[data-theme="dark"]{--bg:#0e141c;--karte:#18212c;--text:#eef2f6;--leise:#9aa8b8;--akzent:#7fb0ff;--rand:#2b3744;--fehler:#ff8a80}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  form{width:100%;max-width:360px;background:var(--karte);border:1px solid var(--rand);border-radius:14px;padding:24px}
  h1{margin:0 0 4px;font-size:1.5rem}
  p{margin:0 0 16px;color:var(--leise)}
  input,button{width:100%;font:inherit;padding:10px 12px;border-radius:8px}
  input{border:1px solid var(--rand);background:var(--bg);color:var(--text);margin-bottom:12px}
  button{border:0;background:var(--akzent);color:var(--karte);font-weight:700;cursor:pointer}
  .fehler{color:var(--fehler);margin:0 0 12px}
  .klein{margin:16px 0 0;font-size:.9rem;text-align:center}
  a{color:var(--akzent)}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
</style></head><body>
<form method="post" action="/zugang">
  <h1>${esc(titel)}</h1>
  <p>Dieses Spiel ist nur für Familie und Freunde. Gib das Passwort ein, das du bekommen hast.</p>
  ${hinweis ? `<p class="fehler" role="alert">${esc(hinweis)}</p>` : ''}
  <label for="pw" class="sr">Passwort</label>
  <input id="pw" name="passwort" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Weiter</button>
  <p class="klein"><a href="/datenschutz">Datenschutz</a></p>
</form></body></html>`);
  }

  function formularLesen(req){
    return new Promise(ok => {
      let d = '';
      req.on('data', c => { d += c; if (d.length > 2000) req.destroy(); });
      req.on('end', () => ok(new URLSearchParams(d).get('passwort') || ''));
      req.on('error', () => ok(''));
    });
  }

  // Gibt true zurück, wenn die Anfrage hier beantwortet wurde.
  function pruefen(req, res){
    const pfad = new URL(req.url, 'http://x').pathname;
    if (offenePfade.has(pfad)) return false;

    if (req.method === 'POST' && pfad === '/zugang'){
      (async () => {
        const ip = ipAus(req), j = Date.now();
        const v = versuche.get(ip) || { n:0, bis:j + 15 * 60_000 };
        versuche.set(ip, v);
        if (v.n >= 10) return seite(res, 429, 'Zu viele Versuche. Warte ein paar Minuten.');
        const eingabe = await formularLesen(req);
        const a = Buffer.from(eingabe), b = Buffer.from(passwort);
        const ok = passwort && a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok){ v.n++; return seite(res, 401, passwort ? 'Das Passwort stimmt nicht.' : 'Der Zugang ist noch nicht eingerichtet.'); }
        versuche.delete(ip);
        const sicher = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
        res.writeHead(303, { 'Set-Cookie':`zugang=${schluessel}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${sicher}`, Location:'/' });
        res.end();
      })();
      return true;
    }

    if (hatZugang(req)) return false;
    if (req.method === 'GET' && (pfad === '/' || pfad.endsWith('.html'))){
      seite(res, 401, passwort || !aufRender ? '' : 'Der Zugang ist noch nicht eingerichtet.');
    } else {
      res.writeHead(401, { 'Content-Type':'text/plain; charset=utf-8' });
      res.end('Kein Zugang');
    }
    return true;
  }

  return { pruefen, hatZugang };
};
