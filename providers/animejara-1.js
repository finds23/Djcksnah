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
  Uqload: true,      // sin probar
  Yourupload: true,  // sin probar
  Okru: true,        // sin probar
  Filemoon: false,   // pendiente: usa un API cifrado
  Upnshare: false    // pendiente
};
// Mientras se prueba el plugin: si no se encuentra nada, la lista de Nuvio muestra una entrada "DIAGNOSTICO"
// con los pasos que se dieron. Poner en false cuando todo funcione.
var VERSION = "1.4.1"; // se muestra en el diagnostico para saber que copia del plugin esta cargando Nuvio
var DEBUG = true;
var TRACE = [];
function trace(msg) { TRACE.push(String(msg).replace(/\s+/g, " ").slice(0, 140)); }
function looksBlocked(html) {
  return /just a moment|cf-chl|challenge-platform|attention required|enable javascript and cookies/i.test(html || "");
}
function shortErr(e) { return String(e && e.message || e).replace(/ en https?:\/\/\S+/, ""); }
var SERVER_ORDER = ["Streamtape", "Mp4upload", "Streamhg", "Voe", "Vidhide", "Lulustream", "Uqload", "Yourupload", "Okru"];

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
  var tt0 = /<title[^>]*>([^<]*)/i.exec(html);
  trace("busqueda html: " + html.length + " bytes, titulo=" + (tt0 ? tt0[1].trim().slice(0, 40) : "?") + ", anime-card=" + ((html.match(/anime-card/g) || []).length));
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
  // animejara suele usar el titulo romaji (ej. "sousou-no-frieren"): se prueban tambien los titulos de AniList
  var guessedExtra = [];
  (extra || []).forEach(function (t) {
    var full = slugify(t);
    var short = slugify(String(t).split(":")[0]); // sin subtitulo
    [short, full].forEach(function (sl) {
      if (sl && sl.length >= 8 && guessedExtra.indexOf(sl) === -1) guessedExtra.push(sl);
    });
  });
  var all = [];
  fromSearch.concat(guessed, guessedExtra).forEach(function (sl) { if (all.indexOf(sl) === -1) all.push(sl); });
  return all.slice(0, 8);
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
function packEnc(c, a) {
  return (c < a ? "" : packEnc(parseInt(c / a, 10), a)) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
}
// Desempaqueta eval(function(p,a,c,k,e,d){...}) de Dean Edwards (soporta base 2-62; toString(62) no existe en JS)
function unpackPacker(src) {
  var m = /\}\(\s*(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\[\s\S]|(?!\5)[^\\])*)\5\s*\.split\(\s*['"]\|['"]\s*\)/.exec(src);
  if (!m) return null;
  var p = m[2].replace(/\\(['"\\\/])/g, "$1");
  var radix = parseInt(m[3], 10), count = parseInt(m[4], 10), dict = m[6].split("|");
  var map = {};
  for (var c = count - 1; c >= 0; c--) {
    var key = packEnc(c, radix);
    map[key] = dict[c] || key;
  }
  return p.replace(/\b\w+\b/g, function (w) { return Object.prototype.hasOwnProperty.call(map, w) ? map[w] : w; });
}
function describeHtml(html) {
  var t = /<title[^>]*>([^<]*)/i.exec(html || "");
  return (html || "").length + "b" +
    ", packer=" + (/eval\(function\(p,a,c,k,e,d\)/.test(html) ? "si" : "no") +
    ", m3u8=" + (/m3u8/.test(html) ? "si" : "no") +
    ", links=" + (/var\s+links\s*=/.test(html) ? "si" : "no") +
    ", sources=" + (/sources\s*:/.test(html) ? "si" : "no") +
    (looksBlocked(html) ? ", CLOUDFLARE" : "") +
    ", titulo=" + (t ? t[1].trim().slice(0, 30) : "?");
}
function extractHlsFromHtml(html) {
  var texts = [html];
  var re = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\(\s*['"]\|['"]\s*\)[^\n]*?\)\)/g, m;
  while ((m = re.exec(html)) !== null) {
    try {
      var u = unpackPacker(m[0]);
      if (u) texts.unshift(u);
      else trace("packer: no se pudo leer");
    } catch (e) { trace("packer error: " + shortErr(e)); }
  }
  for (var i = 0; i < texts.length; i++) {
    var lm = /var\s+links\s*=\s*(\{[\s\S]*?\})\s*;/.exec(texts[i]);
    if (lm) {
      try {
        var links = JSON.parse(lm[1]);
        var best = links.hls4 || links.hls2 || links.hls3 || links.hls1 || links.hls;
        if (!best) {
          Object.keys(links).forEach(function (k) { if (!best && /\.m3u8/.test(String(links[k]))) best = links[k]; });
        }
        if (best) return best;
      } catch (e) { /* seguir */ }
    }
    var jm = /["']hls\d?["']\s*:\s*["']([^"']+)["']/.exec(texts[i]);
    if (jm) return jm[1].replace(/\\\//g, "/");
    var fm = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/.exec(texts[i]);
    if (fm) return fm[0];
    var fl = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/.exec(texts[i]);
    if (fl) return fl[1];
    var rel = /["'](\/[^"'\s\\]+\.m3u8[^"'\s\\]*)["']/.exec(texts[i]);
    if (rel) return rel[1];
  }
  return null;
}
// Redireccion por JS / meta refresh / iframe en paginas "Loading..."
function findJsRedirect(html, baseUrl) {
  var pats = [
    /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=\s*["']?([^"'>\s]+)/i,
    /<iframe[^>]+src=["']([^"']+)["']/i
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = pats[i].exec(html);
    if (m) {
      try { return new URL(m[1].replace(/&amp;/g, "&").replace(/\\\//g, "/"), baseUrl).href; } catch (e) { /* siguiente */ }
    }
  }
  return null;
}
function hostOf(u) { try { return new URL(u).host; } catch (e) { return "?"; } }
var MAINJS_DONE = false;
// Diagnostico: la pagina del embed es un cascaron que carga un script; se resume ese script para ver de donde sale el video
async function traceMainJs(html, pageUrl, embedUrl) {
  if (MAINJS_DONE) return;
  MAINJS_DONE = true;
  try {
    var path = "?";
    try { var u = new URL(embedUrl); path = u.pathname + (u.search || ""); } catch (e) { /* sin ruta */ }
    trace("embed ruta: " + path.slice(0, 100));
    var sm = /<script[^>]+src=["']([^"']+)["']/i.exec(html);
    if (!sm) { trace("main.js: la pagina no trae script"); return; }
    var jsUrl = new URL(sm[1].replace(/&amp;/g, "&"), pageUrl).href;
    var resp = await fetch(jsUrl, { headers: { "User-Agent": UA, "Referer": pageUrl } });
    var js = await resp.text();
    trace("main.js: HTTP " + resp.status + ", " + js.length + " bytes");
    var flags = ["fetch(", "XMLHttpRequest", 
