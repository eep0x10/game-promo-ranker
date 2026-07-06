/* ═══════════════════════════════════════════════════════════════════════════
   Game Promo Ranker — frontend (v2)
   - fetch('/api/games') → cards ou tabela por bloco, com gauge de score,
     selo de qualidade de preço, sparkline, Steam Deck, gênero e multi-loja
   - favoritos (localStorage) + tema claro/escuro (localStorage)
   - perfil Steam: grifa wishlist e remove owned
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

// ─── Estado ─────────────────────────────────────────────────────────────────
let PAYLOAD = null;
let WISHLIST = new Set();
let OWNED = new Set();
let COMPARE_ACTIVE = false;
let TAGS = { fav: false, new: false, hist: false, wish: false };
let FREE_PAYLOAD = null, EPIC_PAYLOAD = null, EPIC_ONLY_CHEAPER = false, GP_PAYLOAD = null;

const SCORE_CUTOFF = 7.0;
const LS = { view: "ssr_view", theme: "ssr_theme", favs: "ssr_favs" };

let VIEW = "cards";                 // "cards" | "table"
let FAVS = new Set();               // appids favoritados

// ─── Persistência ───────────────────────────────────────────────────────────
function lsGet(k, def) { try { return localStorage.getItem(k) ?? def; } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function loadFavs() {
  try { FAVS = new Set(JSON.parse(localStorage.getItem(LS.favs) || "[]").map(String)); }
  catch { FAVS = new Set(); }
}
function saveFavs() { lsSet(LS.favs, JSON.stringify([...FAVS])); }

// ─── Helpers ────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function setStatus(msg, cls) {
  const n = el("profile-status");
  n.textContent = msg || "";
  n.className = "profile-status " + (cls || "info");
}
// "R$ 1.299,90" → 1299.90 ; vazio → Infinity
function priceNum(s) {
  let t = String(s || "").replace(/[^\d.,]/g, "");
  if (!t) return Infinity;
  t = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return isNaN(n) ? Infinity : n;
}
function headerImg(g) {
  if (g.header_img) return g.header_img;
  if (g.appid) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`;
  return g.img_url || "";
}
// Banda de cor do score (a..e) — resolve pela variável CSS, então é theme-aware.
function scoreBand(s) {
  s = Number(s) || 0;
  if (s >= 8.5) return "a";
  if (s >= 7.0) return "b";
  if (s >= 5.5) return "c";
  if (s >= 4.0) return "d";
  return "e";
}
function allGames() {
  const o = [];
  for (const b of (PAYLOAD?.blocks || [])) for (const g of b.games) o.push({ g, color: b.color || "#888" });
  return o;
}

// Selo de qualidade do preço (a partir de low_price_brl vs sale_price — já no JSON).
function qualityTier(g) {
  const low = priceNum(g.low_price_brl), sale = priceNum(g.sale_price);
  if (!isFinite(low) || low <= 0 || !isFinite(sale) || sale <= 0) return null;
  const ratio = sale / low;
  const pctAbove = Math.max(0, Math.round((ratio - 1) * 100));
  const verified = g.low_src === "cs";
  let tier, label;
  if (g.historical_low || ratio <= 1.02) { tier = "best"; label = "MENOR PREÇO"; }
  else if (ratio <= 1.10) { tier = "great"; label = "ÓTIMO"; }
  else if (ratio <= 1.25) { tier = "good"; label = "BOM"; }
  else { tier = "ok"; label = "OK"; }
  return { tier, label, pctAbove, verified, lowStr: g.low_price_brl };
}
function dealPct(g) {                // p/ ordenação "mais perto da baixa"
  const q = qualityTier(g);
  return q ? q.pctAbove : Infinity;
}
function qsealHtml(g) {
  const q = qualityTier(g);
  if (!q) return "";
  const pct = q.pctAbove <= 1 ? "na baixa" : `+${q.pctAbove}%`;
  const tip = q.verified ? "vs. menor preço de todos os tempos (CheapShark)"
                         : "vs. menor preço observado (ainda não confirmado como recorde)";
  // Quem NÃO está na baixa (OK/BOM/ÓTIMO): mostra o preço EXATO da baixa histórica
  // ao lado, pra saber quanto o jogo já custou no menor.
  const lowRef = (q.tier !== "best" && q.lowStr)
    ? `<span class="qseal-low" title="menor preço de sempre${q.verified ? " (CheapShark)" : " (observado)"}">↓ ${escapeHtml(q.lowStr)}${q.verified ? "" : " ~"}</span>`
    : "";
  return `<span class="qseal ${q.tier}" title="${escapeHtml(tip)}">${q.label}<span class="pct">${pct}${q.verified ? "" : " ~"}</span>${lowRef}</span>`;
}

// Steam Deck
const DECK = {
  verified:    { cls: "verified",    ic: "✔", t: "Steam Deck: Verificado" },
  playable:    { cls: "playable",    ic: "◐", t: "Steam Deck: Jogável" },
  unsupported: { cls: "unsupported", ic: "✕", t: "Steam Deck: Não suportado" },
  unknown:     { cls: "unknown",     ic: "?", t: "Steam Deck: Não testado" },
};
function deckPill(g, coverStyle) {
  const d = DECK[g.deck];
  if (!d) return "";
  if (coverStyle && (g.deck === "unsupported" || g.deck === "unknown")) return ""; // só os bons na capa
  return `<span class="deck ${d.cls}" title="${d.t}">${d.ic} Deck</span>`;
}

// Sparkline SVG a partir de price_history [{d,p}, ...]
function sparkline(hist) {
  if (!Array.isArray(hist) || hist.length < 2) return "";
  const w = 92, h = 26, pad = 3, n = hist.length;
  const ps = hist.map((x) => Number(x.p) || 0);
  const min = Math.min(...ps), max = Math.max(...ps), span = (max - min) || 1;
  const pts = hist.map((x, i) => [
    pad + i * (w - 2 * pad) / (n - 1),
    pad + (1 - ((Number(x.p) || 0) - min) / span) * (h - 2 * pad),
  ]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts[n - 1];
  const down = ps[n - 1] <= ps[0];
  const col = down ? "var(--green)" : "var(--accent)";
  const area = `${line} L ${last[0].toFixed(1)} ${h - pad} L ${pad.toFixed(1)} ${h - pad} Z`;
  const tip = `histórico: R$ ${min.toFixed(2)}–${max.toFixed(2)} (${n} pontos)`;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(tip)}"><title>${escapeHtml(tip)}</title>
    <path d="${area}" fill="${col}" opacity="0.13"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.3" fill="${col}"/></svg>`;
}

// Melhor loja (multi-store). Só destaca quando outra loja é ESTRITAMENTE mais
// barata que a Steam (empate não conta), com o % de economia.
function storeBestHtml(g) {
  const st = g.stores;
  if (!Array.isArray(st) || st.length < 2) return "";
  const steam = st.find((s) => s.store === "Steam");
  const others = st.filter((s) => s.store !== "Steam" && isFinite(s.price_brl) && s.price_brl > 0);
  if (!others.length) return "";
  const cheapest = others.slice().sort((a, b) => a.price_brl - b.price_brl)[0];
  const steamPrice = steam ? Number(steam.price_brl) : Infinity;
  if (!(cheapest.price_brl < steamPrice - 0.01)) return "";
  const save = isFinite(steamPrice) ? Math.round(100 * (steamPrice - cheapest.price_brl) / steamPrice) : 0;
  return `<div class="store-best win" title="Mais barato fora da Steam">🏷️ Melhor:
    <a href="${escapeHtml(cheapest.url || "#")}" target="_blank" rel="noopener">${escapeHtml(cheapest.store)} ${escapeHtml(cheapest.price)}</a>${save > 0 ? ` <span class="save-pct">−${save}%</span>` : ""}</div>`;
}

function gaugeHtml(score) {
  const s = Number(score) || 0;
  const w = Math.max(3, Math.min(100, s * 10));
  const band = scoreBand(s);
  return `<span class="gauge"><i style="width:${w}%;background:var(--sc-${band})"></i></span>
          <span class="score-num" style="color:var(--sc-${band})">${s.toFixed(1)}</span>`;
}
function scoreNumHtml(score) {
  const s = Number(score) || 0;
  const band = scoreBand(s);
  return `<span class="score-num" style="color:var(--sc-${band})">${s.toFixed(1)}</span>`;
}

// ─── Card ───────────────────────────────────────────────────────────────────
function itemCard(g, rank, isTail) {
  const appid = String(g.appid || "");
  if (COMPARE_ACTIVE && OWNED.has(Number(appid))) return "";
  const wished = COMPARE_ACTIVE && WISHLIST.has(Number(appid));
  const isFav = FAVS.has(appid);
  const cls = ["card"];
  if (isTail) cls.push("tail-row");

  const ribbon =
    (g.is_new ? '<span class="chip new">NEW</span>' : "") +
    (g.historical_low ? '<span class="chip hist">★ baixa</span>' : "") +
    (wished ? '<span class="chip wish">wishlist</span>' : "");

  const tags = (g.tags || g.genres || []).slice(0, 3)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const cover = headerImg(g);
  const coverImg = cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy">` : "";
  const spark = sparkline(g.price_history);
  const lowLine = g.low_price_brl
    ? `<span class="spark-lo">baixa: <b>${escapeHtml(g.low_price_brl)}</b></span>` : "";

  return `
    <div class="${cls.join(" ")}" data-appid="${escapeHtml(appid)}">
      <div class="card-cover">
        ${coverImg}<div class="shade"></div>
        <span class="disc-badge">-${g.discount}%</span>
        <div class="ribbon">${ribbon}</div>
        ${deckPill(g, true) ? `<div class="deck-cover">${deckPill(g, true)}</div>` : ""}
        <button class="fav-btn${isFav ? " on" : ""}" data-fav="${escapeHtml(appid)}" title="${isFav ? "Remover dos favoritos" : "Favoritar"}" aria-pressed="${isFav}">${isFav ? "★" : "☆"}</button>
      </div>
      <div class="card-body">
        <a class="card-title" href="${escapeHtml(g.url || "#")}" target="_blank" rel="noopener"><span class="nm">${escapeHtml(g.name)}</span></a>
        ${tags ? `<div class="tag-row">${tags}</div>` : ""}
        <div class="meta-row"><span class="pos">${g.pct_positive}%</span> positivas · ${escapeHtml(g.reviews_human ?? g.total_reviews)} reviews</div>
        <div class="price-row">
          <span class="price-sale">${escapeHtml(g.sale_price || "")}</span>
          ${g.orig_price ? `<span class="price-orig">${escapeHtml(g.orig_price)}</span>` : ""}
        </div>
        ${qsealHtml(g)}
        ${(spark || lowLine) ? `<div class="spark-row">${spark}${lowLine}</div>` : ""}
        ${storeBestHtml(g)}
        <div class="card-foot">${gaugeHtml(g.score)}</div>
      </div>
    </div>`;
}

// ─── Linha da tabela ────────────────────────────────────────────────────────
function itemRow(g, rank, isTail) {
  const appid = String(g.appid || "");
  if (COMPARE_ACTIVE && OWNED.has(Number(appid))) return "";
  const wished = COMPARE_ACTIVE && WISHLIST.has(Number(appid));
  const isFav = FAVS.has(appid);

  const trCls = [];
  if (isTail) trCls.push("tail-row");
  if (g.is_new) trCls.push("new-row");
  if (g.historical_low) trCls.push("hist-low");
  if (isFav) trCls.push("faved");
  if (wished) trCls.push("wishlisted");

  const badges =
    (g.is_new ? '<span class="badge-inline new">NEW</span>' : "") +
    (g.historical_low ? '<span class="badge-inline hist">BAIXA</span>' : "") +
    (wished ? '<span class="badge-inline wish">WISH</span>' : "");
  const img = g.img_url ? `<img src="${escapeHtml(g.img_url)}" alt="" loading="lazy">` : "";
  const deck = deckPill(g, false);
  const qseal = qsealHtml(g);
  const lowCell = qseal || (g.low_price_brl ? `<span class="muted">${escapeHtml(g.low_price_brl)}</span>` : "—");

  return `
    <tr${trCls.length ? ` class="${trCls.join(" ")}"` : ""} data-appid="${escapeHtml(appid)}">
      <td class="fav"><button class="fav-btn-t${isFav ? " on" : ""}" data-fav="${escapeHtml(appid)}" title="Favoritar" aria-pressed="${isFav}">${isFav ? "★" : "☆"}</button></td>
      <td class="rank">${rank}</td>
      <td class="name"><a href="${escapeHtml(g.url || "#")}" target="_blank" rel="noopener">${img}<span class="t-nm">${escapeHtml(g.name)}${deck ? " " + deck : ""}${badges}</span></a></td>
      <td class="disc">-${g.discount}%</td>
      <td class="pct">${g.pct_positive}%</td>
      <td class="reviews">${escapeHtml(g.reviews_human ?? g.total_reviews)}</td>
      <td class="orig">${escapeHtml(g.orig_price || "")}</td>
      <td class="sale">${escapeHtml(g.sale_price || "")}</td>
      <td class="low-ever">${lowCell}</td>
      <td class="score-cell">${scoreNumHtml(g.score)}</td>
    </tr>`;
}

function tableHead(sort) {
  const arrow = (key) => `<span class="arrow">${sort === key ? "▼" : "⇅"}</span>`;
  const cls = (key) => `sortable${sort === key ? " sorted" : ""}`;
  return `<thead><tr>
    <th></th><th class="col-rank">#</th><th>Nome</th>
    <th class="${cls("discount")}" data-sort="discount">Desc ${arrow("discount")}</th>
    <th class="${cls("pct")}" data-sort="pct">Rev% ${arrow("pct")}</th>
    <th class="col-reviews ${cls("reviews")}" data-sort="reviews">Reviews ${arrow("reviews")}</th>
    <th class="col-orig">Original</th>
    <th class="${cls("price")}" data-sort="price">Promo ${arrow("price")}</th>
    <th class="${cls("deal")}" data-sort="deal">vs. baixa ${arrow("deal")}</th>
    <th class="${cls("score")}" data-sort="score">Score ${arrow("score")}</th>
  </tr></thead>`;
}

// ─── Contêineres (bloco / lista plana) ──────────────────────────────────────
function blockContainer(block, sort) {
  const color = block.color || "#888";
  let top = "", tail = "", topN = 0, tailN = 0, rank = 0;
  for (const g of block.games) {
    rank += 1;
    const isTail = Number(g.score) < SCORE_CUTOFF;
    const r = VIEW === "cards" ? itemCard(g, rank, isTail) : itemRow(g, rank, isTail);
    if (!r) continue;
    if (isTail) { tail += r; tailN += 1; } else { top += r; topN += 1; }
  }
  const total = topN + tailN;
  if (!total) return "";
  const collapsed = tailN > 0 ? " tail-collapsed" : "";
  const toggle = tailN > 0
    ? `<button class="tail-toggle" data-count="${tailN}" aria-expanded="false">▸ Ver mais ${tailN} jogos (score abaixo de ${SCORE_CUTOFF})</button>` : "";

  const header = `<div class="block-header"><span class="block-dot" style="background:${color}"></span>
      <span class="block-name">${escapeHtml(block.name)}</span><span class="block-count">${total} jogos</span></div>`;

  const body = VIEW === "cards"
    ? `<div class="cards-grid">${top}${tail}</div>`
    : `<div class="table-scroll"><table>${tableHead(sort)}<tbody>${top}${tail}</tbody></table></div>`;
  return `<div class="block${collapsed}">${header}${body}${toggle}</div>`;
}

function flatContainer(items, label, sort) {
  let body = "", rank = 0;
  for (const it of items) {
    const r = VIEW === "cards" ? itemCard(it.g, rank + 1, false) : itemRow(it.g, rank + 1, false);
    if (r) { body += r; rank += 1; }
  }
  if (!rank) return "";
  const header = `<div class="block-header"><span class="block-dot" style="background:var(--accent)"></span>
      <span class="block-name">${escapeHtml(label)}</span><span class="block-count">${rank} jogos</span></div>`;
  const inner = VIEW === "cards"
    ? `<div class="cards-grid">${body}</div>`
    : `<div class="table-scroll"><table>${tableHead(sort)}<tbody>${body}</tbody></table></div>`;
  return `<div class="block">${header}${inner}</div>`;
}

// ─── Filtros ────────────────────────────────────────────────────────────────
function filterState() {
  return {
    q: (((el("f-search") || {}).value) || "").trim().toLowerCase(),
    genre: ((el("f-genre") || {}).value) || "",
    minDisc: Number(((el("f-discount") || {}).value) || 0),
    minPct: Number(((el("f-review") || {}).value) || 0),
    sort: ((el("f-sort") || {}).value) || "score",
    tagFav: TAGS.fav, tagNew: TAGS.new, tagHist: TAGS.hist, tagWish: TAGS.wish,
  };
}
function filtersActive(f) {
  return !!f.q || !!f.genre || f.minDisc > 0 || f.minPct > 0 || f.sort !== "score" ||
    f.tagFav || f.tagNew || f.tagHist || f.tagWish;
}
function passesFilter(g, f) {
  if (f.q && !String(g.name || "").toLowerCase().includes(f.q)) return false;
  if (f.genre) {
    const pool = [].concat(g.genres || [], g.tags || []).map((x) => String(x).toLowerCase());
    if (!pool.includes(f.genre.toLowerCase())) return false;
  }
  if (f.minDisc && Number(g.discount) < f.minDisc) return false;
  if (f.minPct && Number(g.pct_positive) < f.minPct) return false;
  if (f.tagFav && !FAVS.has(String(g.appid))) return false;
  if (f.tagNew && !g.is_new) return false;
  if (f.tagHist && !g.historical_low) return false;
  if (f.tagWish && !(COMPARE_ACTIVE && WISHLIST.has(Number(g.appid)))) return false;
  return true;
}
function flatLabel(f) {
  const onlyTag = !f.q && !f.genre && !f.minDisc && !f.minPct;
  const tags = [f.tagFav && "fav", f.tagNew && "new", f.tagHist && "hist", f.tagWish && "wish"].filter(Boolean);
  if (onlyTag && tags.length === 1)
    return { fav: "★ Seus favoritos", new: "Novidades de hoje", hist: "Baixas históricas", wish: "Sua wishlist em promoção" }[tags[0]];
  return "Resultado dos filtros";
}
function sortGames(arr, sort) {
  const cmp = {
    score: (a, b) => b.g.score - a.g.score,
    discount: (a, b) => b.g.discount - a.g.discount,
    deal: (a, b) => dealPct(a.g) - dealPct(b.g),
    reviews: (a, b) => b.g.total_reviews - a.g.total_reviews,
    pct: (a, b) => (b.g.pct_positive - a.g.pct_positive) || (b.g.total_reviews - a.g.total_reviews),
    price: (a, b) => priceNum(a.g.sale_price) - priceNum(b.g.sale_price),
  }[sort] || ((a, b) => b.g.score - a.g.score);
  arr.sort(cmp);
}

// ─── Render principal ───────────────────────────────────────────────────────
function renderGames() {
  if (!PAYLOAD) return;
  const root = el("games-root");
  const f = filterState();
  const active = filtersActive(f);
  const fc = el("f-clear");
  if (fc) fc.classList.toggle("hidden", !active);

  if (active) {
    let items = allGames().filter(({ g }) => {
      if (COMPARE_ACTIVE && OWNED.has(Number(g.appid))) return false;
      return passesFilter(g, f);
    });
    sortGames(items, f.sort);
    root.innerHTML = flatContainer(items, flatLabel(f), f.sort) ||
      '<div class="empty-tier">Nenhum jogo com esses filtros.</div>';
    wireDynamic();
    return;
  }

  let html = "";
  for (const block of (PAYLOAD.blocks || [])) html += blockContainer(block, f.sort);
  root.innerHTML = html || '<div class="empty-tier">Nenhum jogo a exibir.</div>';
  wireDynamic();
}

// Liga os controles renderizados dinamicamente (tail toggles + sort headers).
function wireDynamic() {
  el("games-root").querySelectorAll(".tail-toggle").forEach((btn) => btn.addEventListener("click", toggleTail));
  el("games-root").querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const sel = el("f-sort"); if (sel) { sel.value = th.dataset.sort; renderGames(); }
  }));
}
function toggleTail(e) {
  const btn = e.currentTarget, block = btn.closest(".block");
  if (!block) return;
  const opened = block.classList.toggle("tail-collapsed") === false;
  btn.setAttribute("aria-expanded", String(opened));
  const n = btn.dataset.count || "";
  btn.textContent = opened
    ? `▾ Ocultar os ${n} jogos com score abaixo de ${SCORE_CUTOFF}`
    : `▸ Ver mais ${n} jogos (score abaixo de ${SCORE_CUTOFF})`;
}

// ─── Hero: stats ao vivo + gênero ───────────────────────────────────────────
function renderSubtitle() {
  if (!PAYLOAD) return;
  const when = PAYLOAD.generated_at_human || PAYLOAD.generated_at || "—";
  const total = PAYLOAD.total_collected != null ? PAYLOAD.total_collected : "—";
  el("subtitle").textContent = `Atualizado em ${when} · ${total} jogos rankeados`;
}
function renderStats() {
  if (!PAYLOAD) return;
  const games = allGames().map((x) => x.g);
  const total = PAYLOAD.total_collected ?? games.length;
  const histLow = games.filter((g) => g.historical_low).length;
  const favOnSale = games.filter((g) => FAVS.has(String(g.appid)));
  const favLow = favOnSale.filter((g) => g.historical_low).length;
  let best = games[0] || null;
  for (const g of games) if (!best || g.score > best.score) best = g;

  const tiles = [
    { cls: "", k: total, l: "jogos rankeados" },
    { cls: "is-gold", k: histLow, l: "na <b>baixa histórica</b>" },
    { cls: "is-violet clickable", k: FAVS.size, l: favLow ? `favoritos · <b>${favLow} na baixa!</b>` : "favoritos salvos", act: "fav" },
    { cls: "is-green", k: best ? best.score.toFixed(1) : "—", l: best ? `melhor: <b>${escapeHtml(best.name.slice(0, 22))}</b>` : "melhor score" },
  ];
  el("stat-strip").innerHTML = tiles.map((t) =>
    `<div class="stat-tile ${t.cls}"${t.act ? ` data-act="${t.act}" style="cursor:pointer"` : ""}>
      <div class="k">${t.k}</div><div class="l">${t.l}</div></div>`).join("");
  el("stat-strip").querySelectorAll("[data-act='fav']").forEach((n) =>
    n.addEventListener("click", () => toggleTag("fav")));
}
function populateGenres() {
  const sel = el("f-genre");
  if (!sel) return;
  const set = new Set();
  for (const { g } of allGames()) for (const x of (g.genres || [])) set.add(x);
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os gêneros</option>' +
    [...set].sort().map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
  if (cur) sel.value = cur;
  sel.classList.toggle("hidden", set.size === 0);
}

// ─── Favoritos ──────────────────────────────────────────────────────────────
function toggleFav(appid) {
  appid = String(appid);
  if (FAVS.has(appid)) FAVS.delete(appid); else FAVS.add(appid);
  saveFavs();
  // atualiza os botões no DOM sem re-render (mantém scroll)
  document.querySelectorAll(`[data-fav="${CSS.escape(appid)}"]`).forEach((btn) => {
    const on = FAVS.has(appid);
    btn.classList.toggle("on", on);
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", String(on));
    const card = btn.closest(".card"); if (card) card.classList.toggle("faved-card", on);
    const row = btn.closest("tr"); if (row) row.classList.toggle("faved", on);
  });
  renderStats();
  if (TAGS.fav) renderGames();      // se o filtro de favoritos está ativo, refaz a lista
}

// ─── View toggle + tema ─────────────────────────────────────────────────────
function setView(v) {
  VIEW = v === "table" ? "table" : "cards";
  lsSet(LS.view, VIEW);
  document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === VIEW));
  renderGames();
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  lsSet(LS.theme, t);
  const btn = el("theme-btn");
  if (btn) btn.textContent = t === "light" ? "☀️" : "🌙";
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
}

// ─── Tags / limpar ──────────────────────────────────────────────────────────
function toggleTag(tag) {
  if (tag === "wish" && !COMPARE_ACTIVE) { setStatus("Compare seu perfil primeiro para filtrar pela wishlist.", "warn"); return; }
  if (tag === "fav" && FAVS.size === 0 && !TAGS.fav) { setStatus("Você ainda não favoritou nenhum jogo (clique na ★ de um card).", "info"); return; }
  TAGS[tag] = !TAGS[tag];
  syncTagUI();
  renderGames();
}
function syncTagUI() {
  document.querySelectorAll(".legend .legend-item").forEach((n) => n.classList.toggle("active", !!TAGS[n.dataset.tag]));
  const wb = el("wishonly-btn");
  if (wb) { wb.classList.toggle("active", TAGS.wish); wb.textContent = TAGS.wish ? "✕ Ver todos os jogos" : "★ Ver apenas wishlist"; }
}
function clearFilters() {
  ["f-search"].forEach((id) => { if (el(id)) el(id).value = ""; });
  if (el("f-genre")) el("f-genre").value = "";
  if (el("f-discount")) el("f-discount").value = "0";
  if (el("f-review")) el("f-review").value = "0";
  if (el("f-sort")) el("f-sort").value = "score";
  TAGS.fav = TAGS.new = TAGS.hist = TAGS.wish = false;
  syncTagUI(); renderGames();
}

// ─── Abas ───────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
}
function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  el("tab-deals").classList.toggle("hidden", tab !== "deals");
  el("tab-epic").classList.toggle("hidden", tab !== "epic");
  el("tab-free").classList.toggle("hidden", tab !== "free");
  el("tab-gamepass").classList.toggle("hidden", tab !== "gamepass");
  if (tab === "free" && FREE_PAYLOAD === null) loadFreeGames();
  if (tab === "epic" && EPIC_PAYLOAD === null) loadEpicGames();
  if (tab === "gamepass" && GP_PAYLOAD === null) loadGamepass();
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── Grátis (Epic + PSN) ────────────────────────────────────────────────────
function freeCard(item, kind) {
  const cover = item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy">` : '<div class="free-noimg">🎮</div>';
  const plat = String(item.platform || "epic");
  const platLabel = { epic: "Epic", psn: "PSN", prime: "Prime", gog: "GOG" }[plat] || plat;
  let meta = "";
  if (kind === "current") meta = item.free_until ? "Grátis até " + fmtDate(item.free_until) : "Grátis agora";
  else if (kind === "upcoming") meta = item.free_from ? "Grátis a partir de " + fmtDate(item.free_from) : "Em breve";
  else meta = item.first_seen ? "Foi grátis em " + fmtDate(item.first_seen) : "";
  const orig = item.orig_price ? `<span class="free-orig">${escapeHtml(item.orig_price)}</span>` : "";
  const btnLabel = kind === "current" ? "Resgatar grátis" : "Ver na loja";
  const btnCls = kind === "current" ? "free-btn" : "free-btn soon";
  return `<div class="free-card ${kind}">
      <a class="free-cover" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${cover}<span class="plat-badge plat-${escapeHtml(plat)}">${escapeHtml(platLabel)}</span></a>
      <div class="free-body"><div class="free-title">${escapeHtml(item.title)}</div>
        <div class="free-sub">${escapeHtml(item.seller || "")} ${orig}</div>
        <div class="free-meta">${escapeHtml(meta)}</div>
        <a class="${btnCls}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${btnLabel}</a></div></div>`;
}
function freeSection(title, items, kind) {
  if (!items || !items.length) return "";
  return `<h2 class="free-h2">${title} <span class="free-n">${items.length}</span></h2>
          <div class="free-grid">${items.map((it) => freeCard(it, kind)).join("")}</div>`;
}
function renderFree() {
  if (!FREE_PAYLOAD) return;
  el("free-subtitle").textContent = "Atualizado em " + (FREE_PAYLOAD.generated_at_human || "—");
  const cur = FREE_PAYLOAD.current || [], up = FREE_PAYLOAD.upcoming || [];
  const curTitles = new Set(cur.map((c) => c.title));
  const hist = (FREE_PAYLOAD.history || []).filter((h) => !curTitles.has(h.title));
  el("free-root").innerHTML =
    (freeSection("🎁 Grátis agora", cur, "current") + freeSection("⏳ Em breve", up, "upcoming") +
     freeSection("📜 Histórico — já passou", hist, "history")) ||
    '<div class="empty-tier">Nenhum jogo grátis no momento. Volte amanhã 🙂</div>';
}
async function loadFreeGames() {
  const loading = el("free-loading");
  try {
    const r = await fetch("/api/free-games", { cache: "no-store" });
    if (r.status === 503) { loading.textContent = "Os jogos grátis ainda não foram coletados (aguarde o cron diário)."; return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    FREE_PAYLOAD = await r.json(); loading.classList.add("hidden"); renderFree();
  } catch (e) { loading.textContent = "Falha ao carregar jogos grátis: " + e.message; }
}

// ─── Promoções Epic ─────────────────────────────────────────────────────────
function epicRow(g, rank) {
  const cover = g.cover ? `<img src="${escapeHtml(g.cover)}" alt="" loading="lazy">` : "";
  const badges =
    (g.cheaper_than_steam ? '<span class="cheaper-badge">MAIS BARATO QUE STEAM</span>' : "") +
    (g.on_steam && !g.cheaper_than_steam ? '<span class="onsteam-badge">também na Steam</span>' : "");
  let steamCell = '<span class="muted">—</span>';
  if (g.on_steam) {
    const cls = g.cheaper_than_steam ? "steam-loses" : "";
    const extra = g.cheaper_than_steam ? ` <span class="save-pct">−${g.steam_save_pct}%</span>` : "";
    steamCell = `<a href="${escapeHtml(g.steam_url || "#")}" target="_blank" rel="noopener" class="${cls}">${escapeHtml(g.steam_price || "")}${extra}</a>`;
  }
  return `<tr${g.cheaper_than_steam ? ' class="cheaper-row"' : ""}>
      <td class="rank">${rank}</td>
      <td class="name"><a href="${escapeHtml(g.url)}" target="_blank" rel="noopener">${cover}<span class="t-nm">${escapeHtml(g.title)}${badges}</span></a></td>
      <td class="disc">-${g.discount}%</td>
      <td class="orig">${escapeHtml(g.orig_price || "")}</td>
      <td class="sale">${escapeHtml(g.sale_price || "")}</td>
      <td class="low-ever">${steamCell}</td></tr>`;
}
function epicSort(arr, mode) {
  const cmp = {
    best: (a, b) => (Number(b.cheaper_than_steam) - Number(a.cheaper_than_steam)) ||
      (Number(b.on_steam) - Number(a.on_steam)) || (b.discount - a.discount) || (a.sale_brl - b.sale_brl),
    discount: (a, b) => b.discount - a.discount,
    price: (a, b) => a.sale_brl - b.sale_brl,
  }[mode] || (() => 0);
  arr.sort(cmp);
}
function renderEpic() {
  if (!EPIC_PAYLOAD) return;
  el("epic-subtitle").textContent = "Atualizado em " + (EPIC_PAYLOAD.generated_at_human || "—") +
    " · " + (EPIC_PAYLOAD.total || 0) + " promoções" +
    (EPIC_PAYLOAD.cheaper_than_steam ? " · " + EPIC_PAYLOAD.cheaper_than_steam + " mais baratas que na Steam" : "");
  const q = ((el("epic-search") || {}).value || "").trim().toLowerCase();
  const sort = ((el("epic-sort") || {}).value) || "best";
  let games = (EPIC_PAYLOAD.games || []).slice();
  if (EPIC_ONLY_CHEAPER) games = games.filter((g) => g.cheaper_than_steam);
  if (q) games = games.filter((g) => String(g.title || "").toLowerCase().includes(q));
  epicSort(games, sort);
  let rows = "", rank = 0;
  for (const g of games) rows += epicRow(g, ++rank);
  el("epic-root").innerHTML = rows ? `<div class="block">
      <div class="block-header"><span class="block-dot" style="background:#f5c518"></span><span class="block-name">Promoções Epic</span><span class="block-count">${rank} jogos</span></div>
      <div class="table-scroll"><table><thead><tr><th>#</th><th>Nome</th><th>Desc</th><th>Original</th><th>Promo</th><th>Steam</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : '<div class="empty-tier">Nenhuma promoção com esse filtro.</div>';
}
async function loadEpicGames() {
  const loading = el("epic-loading");
  try {
    const r = await fetch("/api/epic-games", { cache: "no-store" });
    if (r.status === 503) { loading.textContent = "As promoções da Epic ainda não foram coletadas (aguarde o cron diário)."; return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    EPIC_PAYLOAD = await r.json(); loading.classList.add("hidden"); renderEpic();
  } catch (e) { loading.textContent = "Falha ao carregar promoções da Epic: " + e.message; }
}

// ─── Game Pass ──────────────────────────────────────────────────────────────
function gpCard(g) {
  const cover = g.cover ? `<img src="${escapeHtml(g.cover)}" alt="" loading="lazy">` : '<div class="free-noimg">🎮</div>';
  return `<a class="gp-card" href="${escapeHtml(g.url)}" target="_blank" rel="noopener" title="${escapeHtml(g.title)}">
      <div class="gp-cover">${cover}</div><div class="gp-title">${escapeHtml(g.title)}</div><div class="gp-dev">${escapeHtml(g.dev || "")}</div></a>`;
}
function gpSection(title, items, cls) {
  if (!items || !items.length) return "";
  return `<h2 class="free-h2 ${cls || ""}">${title} <span class="free-n">${items.length}</span></h2><div class="gp-grid">${items.map(gpCard).join("")}</div>`;
}
function renderGamepass() {
  if (!GP_PAYLOAD) return;
  el("gp-subtitle").textContent = "Atualizado em " + (GP_PAYLOAD.generated_at_human || "—") + " · " + (GP_PAYLOAD.total || 0) + " jogos no catálogo";
  const q = ((el("gp-search") || {}).value || "").trim().toLowerCase();
  let catalog = GP_PAYLOAD.catalog || [];
  if (q) catalog = catalog.filter((g) => String(g.title || "").toLowerCase().includes(q));
  let html = "";
  if (!q) { html += gpSection("🆕 Chegaram recentemente", GP_PAYLOAD.added, "gp-in"); html += gpSection("👋 Saíram recentemente", GP_PAYLOAD.removed, "gp-out"); }
  html += gpSection(q ? "Resultados da busca" : "📚 Catálogo atual", catalog);
  el("gp-root").innerHTML = html || '<div class="empty-tier">Nenhum jogo encontrado.</div>';
}
async function loadGamepass() {
  const loading = el("gp-loading");
  try {
    const r = await fetch("/api/gamepass", { cache: "no-store" });
    if (r.status === 503) { loading.textContent = "O catálogo do Game Pass ainda não foi coletado (aguarde o cron diário)."; return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    GP_PAYLOAD = await r.json(); loading.classList.add("hidden"); renderGamepass();
  } catch (e) { loading.textContent = "Falha ao carregar o Game Pass: " + e.message; }
}

// ─── Carga inicial ──────────────────────────────────────────────────────────
function skeleton() {
  return '<div class="skeleton-grid">' + Array.from({ length: 8 }, () =>
    '<div class="sk-card"><div class="sk-cover shimmer"></div><div class="sk-line shimmer"></div><div class="sk-line s shimmer"></div></div>').join("") + "</div>";
}
async function loadGames() {
  el("loading").innerHTML = skeleton();
  try {
    const r = await fetch("/api/games", { cache: "no-store" });
    if (r.status === 503) {
      el("loading").classList.add("hidden");
      const box = el("error-box"); box.classList.remove("hidden");
      box.textContent = "Os dados ainda não foram gerados. Rode o cron: python steam_sale_ranker.py 20 --json data/games.json";
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    PAYLOAD = await r.json();
    el("loading").classList.add("hidden");
    renderSubtitle(); renderStats(); populateGenres(); renderGames();
  } catch (e) {
    el("loading").classList.add("hidden");
    const box = el("error-box"); box.classList.remove("hidden");
    box.textContent = "Falha ao carregar /api/games: " + e.message;
  }
}

// ─── Comparação com perfil ──────────────────────────────────────────────────
async function compareProfile() {
  const raw = el("profile-input").value.trim();
  if (!raw) { setStatus("Digite seu perfil Steam primeiro.", "err"); return; }
  const keyInput = el("apikey-input");
  const apiKey = keyInput ? keyInput.value.trim() : "";
  const btn = el("profile-btn"); btn.disabled = true;
  setStatus(apiKey ? "Buscando wishlist e biblioteca…" : "Buscando wishlist…", "info");
  try {
    let url = "/api/steam-user?profile=" + encodeURIComponent(raw);
    if (apiKey) url += "&key=" + encodeURIComponent(apiKey);
    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();
    if (!data.ok) { setStatus((data.error || "perfil privado ou não encontrado") + " — confira se o perfil está público.", "err"); btn.disabled = false; return; }
    WISHLIST = new Set((data.wishlist || []).map(Number));
    OWNED = new Set((data.owned || []).map(Number));
    COMPARE_ACTIVE = true; TAGS.wish = false; syncTagUI();
    el("clear-btn").classList.remove("hidden");
    el("wishonly-btn").classList.toggle("hidden", WISHLIST.size === 0);
    renderGames();
    let msg = `Wishlist: ${WISHLIST.size} jogos (grifados em azul)`;
    msg += OWNED.size ? ` · Biblioteca: ${OWNED.size} jogos (ocultados da lista).` : ".";
    let cls = "ok";
    if (data.warnings && data.warnings.length) { msg += "  Aviso: " + data.warnings.join("; "); cls = "warn"; }
    if (WISHLIST.size === 0 && OWNED.size === 0) {
      msg = "Wishlist pública vazia (ou ainda privada). Deixe a lista de desejos como Pública em Perfil → Editar perfil → Privacidade."; cls = "warn";
    }
    setStatus(msg, cls);
  } catch (e) { setStatus("Erro ao consultar o perfil: " + e.message, "err"); }
  finally { btn.disabled = false; }
}
function clearProfile() {
  WISHLIST = new Set(); OWNED = new Set(); COMPARE_ACTIVE = false; TAGS.wish = false;
  el("clear-btn").classList.add("hidden"); el("wishonly-btn").classList.add("hidden");
  syncTagUI(); setStatus("", "info"); renderGames();
}

// ─── Wire-up ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // estado persistido
  loadFavs();
  applyTheme(lsGet(LS.theme, "dark") === "light" ? "light" : "dark");
  VIEW = lsGet(LS.view, "cards") === "table" ? "table" : "cards";
  document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === VIEW));

  el("theme-btn").addEventListener("click", toggleTheme);
  document.querySelectorAll("#view-toggle button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  el("profile-btn").addEventListener("click", compareProfile);
  el("clear-btn").addEventListener("click", clearProfile);
  el("wishonly-btn").addEventListener("click", () => toggleTag("wish"));
  el("profile-input").addEventListener("keydown", (e) => { if (e.key === "Enter") compareProfile(); });

  setupTabs();
  ["f-search", "f-genre", "f-discount", "f-review", "f-sort"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener(id === "f-search" ? "input" : "change", renderGames);
  });
  if (el("f-clear")) el("f-clear").addEventListener("click", clearFilters);
  document.querySelectorAll(".legend .legend-item").forEach((n) => n.addEventListener("click", () => toggleTag(n.dataset.tag)));

  // favoritos: delegação de evento (cobre cards e tabela)
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fav]");
    if (b) { e.preventDefault(); toggleFav(b.dataset.fav); }
  });

  // Epic
  ["epic-search", "epic-sort"].forEach((id) => { const n = el(id); if (n) n.addEventListener(id === "epic-search" ? "input" : "change", renderEpic); });
  const epicToggle = el("epic-cheaper-toggle");
  if (epicToggle) epicToggle.addEventListener("click", () => { EPIC_ONLY_CHEAPER = !EPIC_ONLY_CHEAPER; epicToggle.classList.toggle("active", EPIC_ONLY_CHEAPER); renderEpic(); });
  const gpSearch = el("gp-search"); if (gpSearch) gpSearch.addEventListener("input", renderGamepass);

  loadGames();
});
