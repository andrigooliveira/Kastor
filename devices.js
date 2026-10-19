/* ───────────────────────────────────────────────────────────────
   reWork — Dispositivos (Perfil › Dispositivos)

   - describe(ua, hints): nome legível do aparelho a partir do User-Agent
     (navegador, sistema, tipo) mais o que o próprio navegador contou pelas
     Client Hints (modelo do Android, versão do Windows).
   - locate(ip): cidade/estado/país do IP, por um serviço de geolocalização
     (GEOIP_URL, com {ip} no lugar do endereço; padrão ipwho.is). Cache de
     24h em memória; IP de rede local não sai do servidor. GEOIP_DISABLED=1
     desliga a consulta (a lista mostra só o IP).
   ─────────────────────────────────────────────────────────────── */
'use strict';

function browserOf(ua) {
  const tests = [
    [/EdgA?\/|Edg\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/SamsungBrowser\//, 'Samsung Internet'],
    [/YaBrowser\//, 'Yandex'],
    [/Vivaldi\//, 'Vivaldi'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/CriOS\//, 'Chrome'],
    [/EdgiOS\//, 'Edge'],
    [/Chrome\/|Chromium\//, 'Chrome'],
    [/Safari\//, 'Safari']
  ];
  for (const [re, name] of tests) if (re.test(ua)) return name;
  return null;
}
function osOf(ua, hints) {
  if (/iPad/.test(ua)) return { os: 'iPadOS', type: 'tablet', device: 'iPad' };
  if (/iPhone|iPod/.test(ua)) return { os: 'iOS', type: 'mobile', device: 'iPhone' };
  if (/Android/.test(ua)) {
    const tablet = !/Mobile/.test(ua);
    // UA reduzido do Chrome esconde o modelo ("K"); o hint traz o real.
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/|\)|;)/);
    const uaModel = m && m[1] && m[1] !== 'K' && !/^(Linux|wv|U)$/.test(m[1]) ? m[1].trim() : null;
    return { os: 'Android', type: tablet ? 'tablet' : 'mobile', device: (hints && hints.model) || uaModel || (tablet ? 'tablet Android' : 'Android') };
  }
  if (/Windows NT/.test(ua)) {
    // Windows 11 se apresenta como NT 10.0; a versão da plataforma (≥ 13) diferencia.
    const pv = parseInt(String((hints && hints.platformVersion) || ''), 10);
    return { os: 'Windows', type: 'desktop', device: pv >= 13 ? 'Windows 11' : pv > 0 ? 'Windows 10' : 'Windows' };
  }
  if (/Macintosh|Mac OS X/.test(ua)) return { os: 'macOS', type: 'desktop', device: 'Mac' };
  if (/CrOS/.test(ua)) return { os: 'ChromeOS', type: 'desktop', device: 'Chromebook' };
  if (/Linux/.test(ua)) return { os: 'Linux', type: 'desktop', device: 'Linux' };
  return { os: null, type: 'desktop', device: null };
}
const clean = (s, n = 60) => (s == null ? null : String(s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) || null);
/* { browser, os, type: 'mobile'|'tablet'|'desktop', device } */
function describe(ua, hints) {
  ua = String(ua || '');
  const h = hints ? { model: clean(hints.model), platformVersion: clean(hints.platformVersion, 20) } : null;
  const o = osOf(ua, h);
  // App instalado (PWA) vem com o mesmo UA do navegador.
  return { browser: browserOf(ua), os: o.os, type: o.type, device: o.device };
}

/* ── Geolocalização por IP ── */
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL_MS = 10 * 60 * 1000;
const _geo = new Map(); // ip → { at, loc, ttl, pending }
function normIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}
function isPrivateIp(ip) {
  const s = normIp(ip);
  if (!s || s === 'unknown' || s === '::1' || s === 'localhost') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(s)) return true;
  const m = s.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true; // CGNAT
  if (/^f[cd][0-9a-f]{2}:/i.test(s) || /^fe80:/i.test(s)) return true;
  return false;
}
function geoEnabled() {
  return !/^(1|true|yes)$/i.test(String(process.env.GEOIP_DISABLED || ''));
}
async function fetchGeo(ip) {
  const tpl = process.env.GEOIP_URL || 'https://ipwho.is/{ip}?fields=success,city,region,country,country_code';
  const url = tpl.replace('{ip}', encodeURIComponent(ip));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.success === false || d.status === 'fail') return null;
    // Formatos do ipwho.is, ipapi.co e ip-api.com.
    const city = clean(d.city, 80);
    const region = clean(d.region || d.regionName || d.region_name, 80);
    const country = clean(d.country || d.country_name, 80);
    const cc = clean(d.country_code || d.countryCode, 2);
    if (!city && !region && !country) return null;
    return { city, region, country, cc: cc ? cc.toUpperCase() : null };
  } catch { return null; }
  finally { clearTimeout(t); }
}
/* Promise<{ city, region, country, cc } | { local: true } | null> */
function locate(ip) {
  const key = normIp(ip);
  if (isPrivateIp(key)) return Promise.resolve({ local: true });
  if (!geoEnabled()) return Promise.resolve(null);
  const hit = _geo.get(key);
  const now = Date.now();
  if (hit && hit.pending) return hit.pending;
  if (hit && now - hit.at < hit.ttl) return Promise.resolve(hit.loc);
  const pending = fetchGeo(key).then(loc => {
    _geo.set(key, { at: Date.now(), loc, ttl: loc ? GEO_TTL_MS : GEO_FAIL_TTL_MS });
    if (_geo.size > 5000) _geo.delete(_geo.keys().next().value);
    return loc;
  });
  _geo.set(key, { at: now, loc: null, ttl: 0, pending });
  return pending;
}
/* Espera a localização no máximo `ms` (a lista não trava por causa dela). */
function locateWithin(ip, ms) {
  return Promise.race([locate(ip), new Promise(r => setTimeout(() => r(undefined), ms))]);
}

module.exports = { describe, locate, locateWithin, isPrivateIp, normIp };
