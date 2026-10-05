/**
 * AnimeJara (animejara.com) - plugin para Nuvio
 * Flujo: TMDB -> slug de la serie (busqueda del catalogo + slugs probables)
 *        -> pagina del episodio /episode/<slug>-<temporada>x<episodio>/
 *        -> const enlaces = [LATINO, JAPONES] (cada uno es un reproductor "multiplayer")
 *        -> la pagina del multiplayer lista los servidores: playVideo("<embed>")
 *        -> extractor por servidor.
 */
var AJ_BASE = "https://animejara.com";
var TMDB_API_KEY = "56db0ec297530920213e1503706b81ff";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Activa/desactiva servidores. Solo los marcados como "probado" se han visto funcionar en otros plugins.
var ENABLED_SOURCES = {
  Streamtape: true,  // probado en JKAnime
  Mp4upload: true,   // portado de Latanime
  Streamhg: true,    // mismo motor que Streamwish (probado en JKAnime)
  Voe: true,         // portado de Latanime; sin confirmar que reproduce
  Vidhide: true,     // sin probar (mismo extractor que Streamhg)
  Lulustream: true,  // sin probar (mismo extractor que Streamhg)
  Filemoon: false,   // pendiente: usa un API cifrado
  Upnshare: false    // pendiente
};
// Mientras se prueba el plugin: si no se encuentra nada, la lista de Nuvio muestra una entrada "DIAGNOSTICO"
// con los pasos que se dieron. Poner en false cuando todo funcione.
var VERSION = "1.0.9"; // se muestra en el diagnostico para saber que copia del plugin esta cargando Nuvio
var DEBUG = true;
var TRACE = [];
function trace(msg) { TRACE.push(String(msg).replace(/\s+/g, " ").slice(0, 140)); }
function looksBlocked(html) {
  return /just a moment|cf-chl|challenge-platform|attention required|enable javascript and cookies/i.test(html || "");
}
function shortErr(e) { return String(e && e.message || e).replace(/ en https?:\/\/\S+/, ""); }
var SERVER_ORDER = ["Streamtape", "Mp4upload", "Streamhg", "Voe", "Vidhide", "Lulustream"];

// ---------- utilidades ----------
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function slugify(s) {
  return norm(s).replace(/['\u2019`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function decodeEntities(s) {
  return String(s || "").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
var MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
function browserHeaders(referer) {
  var h = {
    "User-Agent": MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1"
  };
  if (referer) h["Referer"] = referer;
  return h;
}
function chromeHints(h) {
  h["sec-ch-ua"] = '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"';
  h["sec-ch-ua-mobile"] = "?1";
  h["sec-ch-ua-platform"] = '"Android"';
  return h;
}
var COOKIE_JAR = null;
// Visita la portada para recoger las cookies que el sitio reparte (si el entorno deja leer set-cookie)
async function primeCookies() {
  if (COOKIE_JAR !== null) return COOKIE_JAR;
  COOKIE_JAR = "";
  try {
    var resp = await fetch(AJ_BASE + "/", { headers: browserHeaders(null) });
    var raw = "";
    try { raw = (resp.headers && resp.headers.get && resp.headers.get("set-cookie")) || ""; } catch (_) { /* no legible */ }
    var pairs = raw.split(/,(?=\s*[^;,=\s]+=)/).map(function (c) { return c.split(";")[0].trim(); }).filter(function (c) { return c.indexOf("=") > 0; });
    COOKIE_JAR = pairs.join("; ");
    trace(COOKIE_JAR ? "cookies: " + pairs.length : "cookies: el sitio no entrego/no se pueden leer (HTTP " + resp.status + ")");
  } catch (e) {
    trace("cookies: fallo " + shortErr(e));
  }
  return COOKIE_JAR;
}
// Pagina de animejara.com: prueba varias formas de pedirla (el sitio responde 404 a algunas peticiones que no parecen un navegador)
async function fetchPage(url, referer) {
  var eh = chromeHints(browserHeaders(referer || AJ_BASE + "/"));
  var variants = [
    { tag: "A", url: url, headers: { "User-Agent": UA, "Referer": AJ_BASE + "/" } },
    { tag: "B", url: url, headers: browserHeaders(AJ_BASE + "/") },
    { tag: "C", url: url.replace("//animejara.com", "//www.animejara.com"), headers: browserHeaders("https://www.animejara.com/") },
    { tag: "D", url: url, headers: browserHeaders(null) },
    { tag: "E", url: url, headers: eh }
  ];
  var ep = /\/episode\/([^\/?#]+)/.exec(url);
  if (ep) {
    variants.push({ tag: "G", url: AJ_BASE + "/?post_type=episode&name=" + ep[1], headers: browserHeaders(AJ_BASE + "/") });
    variants.push({ tag: "H", url: AJ_BASE + "/index.php/episode/" + ep[1] + "/", headers: browserHeaders(AJ_BASE + "/") });
  }
  var jar = await primeCookies();
  if (jar) {
    var fh = chromeHints(browserHeaders(referer || AJ_BASE + "/"));
    fh["Cookie"] = jar;
    variants.push({ tag: "F", url: url, headers: fh });
  }
  var notes = [];
  for (var i = 0; i < variants.length; i++) {
    try {
      var resp = await fetch(variants[i].url, { headers: variants[i].headers });
      var text = "";
      try { text = await resp.text(); } catch (_) { /* cuerpo no legible */ }
      // animejara.com sirve la pagina del episodio completa pero con codigo HTTP 404 (raro, pero asi es):
      // lo que cuenta es que el cuerpo traiga la lista "enlaces", no el codigo.
      if (/const\s+enlaces\s*=/.test(text)) {
        if (!resp.ok || notes.length) trace("pagina leida con variante " + variants[i].tag + " (HTTP " + resp.status + ")");
        return text;
      }
      if (resp.ok) return text; // 200 sin lista: getEpisode lo reporta
      notes.push(variants[i].tag + resp.status);
      if (notes.length >= 2) break; // 404 real (el episodio no existe): no tiene sentido seguir probando
      continue;
    } catch (e) {
      notes.push(variants[i].tag + "red");
    }
  }
  throw new Error("HTTP " + notes.join(" "));
}
async function fetchText(url, headers) {
  var resp = await fetch(url, { headers: Object.assign({ "User-Agent": UA }, headers || {}) });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + url);
  return resp.text();
}

// ---------- TMDB ----------
var ASIAN_COUNTRIES = ["JP", "CN", "KR", "TW", "HK"];
async function getTMDBInfo(tmdbId) {
  var base = "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  var langs = ["en-US", "es-MX"];
  var titles = [];
  var main = null;
  for (var i = 0; i < langs.length; i++) {
    try {
      var d = await fetch(base + "&language=" + langs[i], { headers: { "User-Agent": UA } }).then(function (r) { return r.json(); });
      if (!d || d.success === false) continue;
      if (!main) main = d;
      [d.name, d.original_name].forEach(function (t) { if (t && titles.indexOf(t) === -1) titles.push(t); });
    } catch (e) { /* siguiente idioma */ }
  }
  if (!main) return null;
  var isAnimation = (main.genres || []).some(function (g) { return g.id === 16; });
  var asian = (main.origin_country || []).some(function (c) { return ASIAN_COUNTRIES.indexOf(c) !== -1; });
  // Solo titulos con letras latinas sirven para armar slugs
  var latin = titles.filter(function (t) { return slugify(t).length >= 2; });
  var year = main.first_air_date ? parseInt(String(main.first_air_date).slice(0, 4), 10) : null;
  return { titles: latin, isAnime: isAnimation && asian, year: year };
}

// ---------- slug de la serie ----------
var STOP = ["the", "a", "an", "of", "and", "no", "wa", "wo", "ni", "to", "ga", "de", "la", "el", "los", "las", "y", "en", "del"];
function stripSeasonWords(s) {
  return String(s || "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, " ")
    .replace(/\bseason\s*\d{1,2}\b/gi, " ")
    .replace(/\btemporada\s*\d{1,2}\b/gi, " ")
    .replace(/\bpart\s*\d{1,2}\b/gi, " ");
}
function tokens(s) {
  var seen = {}, out = [];
  slugify(stripSeasonWords(s)).split("-").forEach(function (w) {
    if (w && STOP.indexOf(w) === -1 && !seen[w]) { seen[w] = true; out.push(w); }
  });
  return out;
}
function similarity(a, b) {
  var A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (A.join("") === B.join("")) return 1;
  var setB = {};
  B.forEach(function (w) { setB[w] = true; });
  var inter = A.filter(function (w) { return setB[w]; }).length;
  return 2 * inter / (A.length + B.length);
}
// AniList da el titulo romaji / ingles / sinonimos; animejara suele usar el romaji (ej. "Mushoku Tensei: Isekai Ittara Honki Dasu")
async function getExtraTitles(titles) {
  try {
    var query = "query ($search: String) { Page(page: 1, perPage: 6) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { title { romaji english } synonyms } } }";
    var resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: query, variables: { search: titles[0] } })
    });
    if (!resp.ok) return [];
    var json = await resp.json();
    var media = (json && json.data && json.data.Page && json.data.Page.media) || [];
    var out = [];
    media.forEach(function (m) {
      var names = [m.title.romaji, m.title.english].concat(m.synonyms || []).filter(Boolean);
      // solo se usan las entradas de AniList que realmente se parecen a la serie buscada
      var related = names.some(function (n) { return titles.some(function (t) { return similarity(n, t) >= 0.5; }); });
      if (!related) return;
      names.forEach(function (n) { if (slugify(n).length >= 2 && out.indexOf(n) === -1) out.push(n); });
    });
    return out.slice(0, 12);
  } catch (e) {
    trace("AniList fallo: " + shortErr(e));
    return [];
  }
}
async function searchSlugs(title) {
  var html = await fetchText(AJ_BASE + "/catalogo/?q=" + encodeURIComponent(title), { "Referer": AJ_BASE + "/" });
  var out = [], seen = {}, m;
  // Tarjetas de resultados: <a href=".../anime/<slug>/" class="anime-card" data-anime="{&quot;titulo&quot;:..., &quot;anio&quot;:..., &quot;tipo&quot;:...}">
  var cardRe = /<a\b[^>]*?href=["'](?:https?:\/\/(?:www\.)?animejara\.com)?\/(anime|movie)\/([a-z0-9][a-z0-9\-]*)\/?["'][^>]*?class=["'][^"']*anime-card[^"']*["'][^>]*?data-anime=["']([^"']*)["']/gi;
  while ((m = cardRe.exec(html)) !== null) {
    if (seen[m[2]]) continue;
    seen[m[2]] = true;
    var data = {};
    try { data = JSON.parse(decodeEntities(m[3])); } catch (e) { /* tarjeta sin datos */ }
    out.push({ slug: m[2], kind: m[1], titulo: data.titulo || "", anio: parseInt(data.anio, 10) || null, tipo: norm(data.tipo || "") });
  }
  trace("busqueda '" + title + "': " + out.length + " tarjetas" + (out.length ? " (" + out.map(function (c) { return c.slug; }).join(",").slice(0, 70) + ")" : "") + (looksBlocked(html) ? ", CLOUDFLARE" : ""));
  if (out.length === 0) {
    // Respaldo: cualquier enlace /anime/<slug> (puede incluir barras laterales; se filtra luego por similitud)
    var re = /href=["'](?:https?:\/\/(?:www\.)?animejara\.com)?\/(anime)\/([a-z0-9][a-z0-9\-]*)\/?(?:#[^"']*)?["']/gi;
    while ((m = re.exec(html)) !== null) {
      if (!seen[m[2]]) { seen[m[2]] = true; out.push({ slug: m[2], kind: m[1], titulo: "", anio: null, tipo: "" }); }
    }
  }
  return out;
}
async function slugCandidates(titles, year, extra) {
  var matchTitles = titles.concat(extra || []);
  var queries = titles.slice(0, 2).concat((extra || []).slice(0, 2));
  var scored = {};
  for (var i = 0; i < queries.length; i++) {
    try {
      var cards = await searchSlugs(queries[i]);
      cards.forEach(function (c) {
        if (c.kind !== "anime") return; // las peliculas viven en /movie/
        var best = 0;
        matchTitles.forEach(function (t) {
          best = Math.max(best, similarity((c.titulo || c.slug.replace(/-/g, " ")), t));
        });
        var yearMatch = !!(year && c.anio && year === c.anio);
        var accepted = best >= 0.7 || (yearMatch && best >= 0.4 && (c.tipo === "tv" || c.tipo === ""));
        if (!accepted) return;
        var score = best + (yearMatch ? 0.05 : 0) + (c.tipo === "tv" ? 0.03 : 0);
        if (scored[c.slug] === undefined || score > scored[c.slug]) scored[c.slug] = score;
      });
    } catch (e) {
      trace("busqueda '" + queries[i] + "' fallo: " + shortErr(e));
      console.warn("[AnimeJara] Busqueda fallo (\"" + queries[i] + "\"): " + e.message);
    }
    if (Object.keys(scored).length >= 1 && i >= 1) break; // ya hay candidatos fiables
  }
  var fromSearch = Object.keys(scored).sort(function (a, b) { return scored[b] - scored[a]; });
  trace("candidatos: " + (fromSearch.length ? fromSearch.map(function (k) { return k + "(" + scored[k].toFixed(2) + ")"; }).join(",") : "ninguno de la busqueda"));
  var guessed = titles.map(slugify).filter(Boolean);
  var all = [];
  fromSearch.concat(guessed).forEach(function (sl) { if (all.indexOf(sl) === -1) all.push(sl); });
  return all.slice(0, 5);
}

// ---------- pagina del episodio ----------
async function getEpisode(slug, season, episode) {
  var url = AJ_BASE + "/episode/" + slug + "-" + season + "x" + episode + "/";
  var html = await fetchPage(url, AJ_BASE + "/anime/" + slug);
  var m = /const\s+enlaces\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (!m) throw new Error("sin 'enlaces' (" + html.length + " bytes" + (looksBlocked(html) ? ", CLOUDFLARE" : "") + ")");
  var links;
  try { links = JSON.parse(m[1]); } catch (e) { throw new Error("enlaces no es JSON"); }
  if (!Array.isArray(links) || links.length === 0) throw new Error("enlaces vacio");
  // Etiquetas de las pestañas de idioma, en el mismo orden que "enlaces"
  var labels = [], lr = /lang-name["']?>\s*([^<]+?)\s*</gi, lm;
  while ((lm = lr.exec(html)) !== null) labels.push(norm(lm[1]));
  var langs = links.map(function (_, i) {
    var label = labels.length === links.length ? labels[i] : (i === 0 ? "latino" : "japones");
    return label.indexOf("latino") !== -1 ? "latino" : (label.indexOf("castellano") !== -1 ? "castellano" : "japones");
  });
  return { url: url, links: links, langs: langs };
}

// ---------- lista de servidores del multiplayer ----------
async function getServers(embedPageUrl, referer) {
  var html = await fetchText(embedPageUrl, { "Referer": referer });
  var re = /<li\b[^>]*?onclick=["'][^"']*?playVideo\(\s*(?:&quot;|&#34;|'|\\")(https?:[^"'\\]+?)(?:&quot;|&#34;|'|\\")\s*\)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  var out = [], m;
  while ((m = re.exec(html)) !== null) {
    var nm = /nombre-server["']?>\s*([^<]+?)\s*</i.exec(m[2]) || /alt=["']([^"']+)["']/i.exec(m[2]);
    out.push({ name: nm ? nm[1].trim() : "?", url: decodeEntities(m[1]) });
  }
  return out;
}

// ---------- extractores ----------
function unpackPacker(src) {
  var m = /\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/.exec(src);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var radix = parseInt(m[2], 10), count = parseInt(m[3], 10), dict = m[4].split("|");
  while (count--) {
    if (dict[count]) p = p.replace(new RegExp("\\b" + count.toString(radix) + "\\b", "g"), dict[count]);
  }
  return p;
}
function extractHlsFromHtml(html) {
  var texts = [html];
  var re = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)[^\n]*?\)\)/g, m;
  while ((m = re.exec(html)) !== null) {
    try { var u = unpackPacker(m[0]); if (u) texts.unshift(u); } catch (e) { /* siguiente */ }
  }
  for (var i = 0; i < texts.length; i++) {
    var lm = /var\s+links\s*=\s*(\{[\s\S]*?\})\s*;/.exec(texts[i]);
    if (lm) {
      try {
        var links = JSON.parse(lm[1]);
        var best = links.hls2 || links.hls4 || links.hls3;
        if (best) return best;
      } catch (e) { /* seguir */ }
    }
    var fm = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/.exec(texts[i]);
    if (fm) return fm[0];
  }
  return null;
}
async function extractPackedHls(embedUrl, ctx) {
  var resp = await fetch(embedUrl, { headers: { "User-Agent": UA, "Referer": (ctx && ctx.referer) || AJ_BASE + "/" } });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + embedUrl);
  var html = await resp.text();
  var url = extractHlsFromHtml(html);
  if (!url) throw new Error("No se encontro la URL HLS en el embed");
  var origin;
  try { origin = new URL(resp.url || embedUrl).origin; } catch (e) { origin = "https://hgcloud.to"; }
  return { url: url, type: "hls", headers: { "Referer": origin + "/", "Origin": origin, "User-Agent": UA } };
}
async function extractVidhide(embedUrl, ctx) {
  try {
    return await extractPackedHls(embedUrl, ctx);
  } catch (e) {
    if (/\/v\//.test(embedUrl)) return extractPackedHls(embedUrl.replace("/v/", "/e/"), ctx);
    throw e;
  }
}

function extractStreamtapeFromHtml(html) {
  var re = /getElementById\('(?:robotlink|botlink)'\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*(?:''\s*\+\s*)?\(\s*['"]([^'"]*)['"]\s*\)((?:\.substring\(\d+\))*)/g;
  var m, last = null;
  while ((m = re.exec(html)) !== null) last = m; // 'ideoolink' son senuelos; robotlink/botlink dan el enlace valido
  if (!last) return null;
  var tail = last[2];
  (last[3].match(/\.substring\(\d+\)/g) || []).forEach(function (s) { tail = tail.substring(parseInt(/\d+/.exec(s)[0], 10)); });
  var url = last[1] + tail;
  if (url.indexOf("//") === 0) url = "https:" + url;
  return url + "&stream=1";
}
async function extractStreamtape(embedUrl, ctx) {
  var html = await fetchText(embedUrl, { "Referer": (ctx && ctx.referer) || AJ_BASE + "/" });
  var url = extractStreamtapeFromHtml(html);
  if (!url) throw new Error("No se encontro el enlace en el embed de Streamtape");
  return { url: url, headers: { "Referer": "https://streamtape.com/", "User-Agent": UA } };
}

async function extractMp4upload(embedUrl, ctx) {
  var html = await fetchText(embedUrl, { "Referer": (ctx && ctx.referer) || AJ_BASE + "/" });
  var patterns = [
    /src\s*:\s*["']([^"']+\.mp4[^"']*)["']/i,
    /src\s*=\s*["']([^"']+\.mp4[^"']*)["']/i,
    /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/i
  ];
  var videoUrl = null;
  for (var i = 0; i < patterns.length && !videoUrl; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) videoUrl = m[1];
  }
  if (!videoUrl) throw new Error("No se encontro una fuente MP4 en MP4Upload");
  videoUrl = videoUrl.trim();
  if (videoUrl.indexOf("//") === 0) videoUrl = "https:" + videoUrl;
  else if (videoUrl.charAt(0) === "/") videoUrl = new URL(embedUrl).origin + videoUrl;
  return { url: videoUrl, headers: { "Referer": embedUrl, "User-Agent": UA } };
}

// VOE: el JSON del embed va ofuscado (rot13 + marcadores + base64 + desplazamiento)
var VOE_MARKERS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
function voeRot13(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    var code = c.charCodeAt(0), base = code <= 90 ? 65 : 97;
    return String.fromCharCode((code - base + 13) % 26 + base);
  });
}
function decodeVoePayload(raw) {
  var x = voeRot13(raw);
  VOE_MARKERS.forEach(function (mk) { x = x.split(mk).join("_"); });
  x = x.split("_").join("");
  x = atob(x);
  x = Array.from(x).map(function (c) { return String.fromCharCode((c.charCodeAt(0) - 3 + 256) % 256); }).join("");
  x = x.split("").reverse().join("");
  x = atob(x);
  return JSON.parse(x);
}
async function extractVoe(embedUrl, ctx) {
  async function getHtml(url) {
    var resp = await fetch(url, { headers: { "User-Agent": UA, "Referer": (ctx && ctx.referer) || AJ_BASE + "/" } });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + url);
    return { html: await resp.text(), url: resp.url || url };
  }
  var page = await getHtml(embedUrl);
  var jsRedirect = page.html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
  if (jsRedirect) page = await getHtml(jsRedirect[1]);
  var sm = page.html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!sm) throw new Error("VOE: no se encontro el JSON del embed");
  var arr = JSON.parse(decodeEntities(sm[1].trim()).replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  if (!Array.isArray(arr) || !arr[0]) throw new Error("VOE: payload inesperado");
  var decoded = decodeVoePayload(arr[0]);
  var origin;
  try { origin = new URL(page.url).origin; } catch (e) { origin = new URL(embedUrl).origin; }
  var out = [];
  if (decoded.source) {
    out.push({ url: decoded.source, type: "hls", tag: "HLS", headers: { "Referer": origin + "/", "User-Agent": UA } });
  }
  var mp4 = decoded.fallback && decoded.fallback[0] && decoded.fallback[0].file;
  if (mp4) out.push({ url: mp4, tag: "MP4", headers: { "User-Agent": UA } });
  if (!out.length) throw new Error("VOE: sin source ni fallback");
  return out;
}

var EXTRACTORS = {
  Streamtape: { label: "Streamtape", extract: extractStreamtape },
  Mp4upload: { label: "MP4Upload", extract: extractMp4upload },
  Streamhg: { label: "StreamHG", extract: extractPackedHls },
  Voe: { label: "VOE", extract: extractVoe },
  Vidhide: { label: "Vidhide", extract: extractVidhide },
  Lulustream: { label: "Lulustream", extract: extractPackedHls }
};
function findSourceKey(serverName) {
  var n = norm(serverName);
  return Object.keys(EXTRACTORS).filter(function (k) { return ENABLED_SOURCES[k]; }).find(function (k) { return n.indexOf(k.toLowerCase()) !== -1; });
}

// ---------- punto de entrada ----------
async function getStreams(tmdbId, type, season, episode) {
  if (!tmdbId || type !== "tv") return [];
  TRACE = [];
  trace("AnimeJara v" + VERSION);
  try {
    var seasonNum = season ? Number(season) : 1;
    var episodeNum = episode !== undefined ? Number(episode) : 1;
    var info = await getTMDBInfo(tmdbId);
    if (!info) { trace("TMDB fallo"); return diagnostic(); }
    trace("TMDB: " + info.titles.slice(0, 2).join(" / ") + " (" + info.year + ") T" + seasonNum + "E" + episodeNum);
    if (!info.isAnime) {
      trace("descartado: no parece anime (animacion + pais asiatico)");
      console.log("[AnimeJara] Descartado (no parece anime): " + (info.titles[0] || tmdbId));
      return diagnostic();
    }
    var extra = await getExtraTitles(info.titles);
    var slugs = await slugCandidates(info.titles, info.year, extra);
    console.log("[AnimeJara] Candidatos de slug: " + slugs.join(", ") + " | T" + seasonNum + "E" + episodeNum);

    var ep = null, usedSlug = null;
    for (var i = 0; i < slugs.length && !ep; i++) {
      try {
        ep = await getEpisode(slugs[i], seasonNum, episodeNum);
        if (ep) usedSlug = slugs[i];
      } catch (e) {
        trace(slugs[i] + ": " + shortErr(e));
        console.log("[AnimeJara] " + slugs[i] + " no sirve: " + e.message);
      }
    }
    if (!ep) {
      // Para el diagnostico: ¿se puede abrir la pagina de la serie? ¿cuantos enlaces de episodio trae?
      try {
        var sp = await fetch(AJ_BASE + "/anime/" + slugs[0], { headers: browserHeaders(AJ_BASE + "/") });
        var sh = sp.ok ? await sp.text() : "";
        var links = (sh.match(/\/episode\/[a-z0-9\-]+\//gi) || []);
        var uniq = links.filter(function (l, i) { return links.indexOf(l) === i; });
        trace("serie /anime/" + slugs[0] + ": HTTP " + sp.status + ", " + sh.length + " bytes, " + uniq.length + " enlaces de episodio" + (uniq[0] ? " (ej. " + uniq[0] + ")" : ""));
      } catch (e) {
        trace("serie: fallo " + shortErr(e));
      }
      // Controles: episodios que SI existen (vistos en el navegador) para saber si el problema es el sitio o la ruta del episodio pedido
      if (DEBUG) {
        try {
          var mr = await fetch("https://multiplayer.streamhj.top/player/multiplayer/embed.php?idanime=4863&idcapitulo=1", { headers: browserHeaders(AJ_BASE + "/") });
          var mt = mr.ok ? await mr.text() : "";
          trace("control multiplayer(4863/1): HTTP " + mr.status + (mr.ok ? ", " + mt.length + " bytes, servidores=" + ((mt.match(/playVideo\(/g) || []).length) : ""));
        } catch (e) {
          trace("control multiplayer: " + shortErr(e));
        }
        var controls = ["black-clover-1x170", "tokyo-revengers-4x1"];
        for (var ci = 0; ci < controls.length; ci++) {
          try {
            var cr = await fetch(AJ_BASE + "/episode/" + controls[ci] + "/", { headers: browserHeaders(AJ_BASE + "/") });
            var ct = await cr.text();
            var hv = function (n) { try { return (cr.headers && cr.headers.get && cr.headers.get(n)) || ""; } catch (_) { return ""; } };
            var tt = /<title[^>]*>([^<]*)/i.exec(ct);
            var snippet = tt ? tt[1].trim() : ct.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
            trace("control " + controls[ci] + ": HTTP " + cr.status + ", " + ct.length + " bytes" + (cr.ok ? ", enlaces=" + (/const\s+enlaces/.test(ct) ? "si" : "no") : "") +
              " | server=" + (hv("server") || "?") + (hv("cf-mitigated") ? " cf-mitigated=" + hv("cf-mitigated") : "") + " | ctype=" + (hv("content-type").split(";")[0] || "?") + " | \"" + snippet.slice(0, 70) + "\"");
          } catch (e) {
            trace("control " + controls[ci] + ": " + shortErr(e));
          }
        }
      }
      trace("episodio no encontrado (slugs: " + slugs.join(",") + ")");
      console.warn("[AnimeJara] No se encontro la pagina del episodio.");
      return diagnostic();
    }
    trace("episodio ok: " + usedSlug + " (" + ep.langs.join("+") + ")");
    console.log("[AnimeJara] Episodio: " + ep.url + " (" + ep.langs.join(", ") + ")");

    var results = [];
    for (var li = 0; li < ep.links.length; li++) {
      var lang = ep.langs[li];
      var servers = [];
      try {
        servers = await getServers(ep.links[li], ep.url);
      } catch (e) {
        trace("reproductor " + lang + " fallo: " + shortErr(e));
        console.warn("[AnimeJara] No se pudo leer el reproductor (" + lang + "): " + e.message);
        continue;
      }
      trace(lang + ": " + servers.length + " servidores" + (servers.length ? " (" + servers.map(function (x) { return x.name; }).join(",") + ")" : ""));
      console.log("[AnimeJara] " + lang + " servidores: " + servers.map(function (s) { return s.name; }).join(", "));
      var jobs = servers.map(async function (server) {
        var key = findSourceKey(server.name);
        if (!key) return null;
        var source = EXTRACTORS[key];
        try {
          var resolved = await source.extract(server.url, { referer: ep.links[li] });
          var list = Array.isArray(resolved) ? resolved : [resolved];
          return list.map(function (v) {
            var o = {
              name: "AnimeJara",
              title: "",
              url: v.url,
              quality: "\uD83D\uDCFA " + source.label + (v.tag ? " (" + v.tag + ")" : "") + "\n1080p | WEB-DL | Anime\n" +
                (lang === "latino" ? "\uD83C\uDDF2\uD83C\uDDFD LATINO" : (lang === "castellano" ? "\uD83C\uDDEA\uD83C\uDDF8 CASTELLANO" : "\uD83C\uDDEF\uD83C\uDDF5 JAPON\u00C9S \u00B7 Sub")),
              headers: v.headers,
              _lang: lang,
              _rank: SERVER_ORDER.indexOf(key)
            };
            if (v.type) o.type = v.type;
            return o;
          });
        } catch (e) {
          trace(source.label + " (" + lang + ") fallo: " + shortErr(e));
          console.warn("[" + source.label + "] fallo: " + e.message);
          return null;
        }
      });
      var done = await Promise.all(jobs);
      done.filter(Boolean).forEach(function (arr) { results = results.concat(arr); });
    }
    results.sort(function (a, b) {
      var order = { latino: 0, castellano: 1, japones: 2 };
      if (a._lang !== b._lang) return order[a._lang] - order[b._lang];
      return a._rank - b._rank;
    });
    results.forEach(function (r) { delete r._lang; delete r._rank; });
    console.log("[AnimeJara] " + results.length + " streams");
    if (results.length === 0) return diagnostic();
    return results;
  } catch (e) {
    trace("error: " + shortErr(e));
    console.error("[AnimeJara] Error: " + e.message);
    return diagnostic();
  }
}

// Entrada informativa (no reproducible) para ver en la lista de Nuvio por que no salio nada
function diagnostic() {
  if (!DEBUG) return [];
  return [{
    name: "AnimeJara",
    title: "",
    url: AJ_BASE + "/",
    quality: "\uD83D\uDEE0 DIAGNOSTICO (no reproducir)\n" + TRACE.join("\n"),
    headers: {}
  }];
}

exports.getStreams = getStreams;
