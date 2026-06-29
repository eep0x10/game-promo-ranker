/* Steam Sale Ranker — frontend logic
   - fetch('/api/games')  → renderiza tabelas por block (mesmo visual do HTML gerado)
   - busca de perfil      → grifa wishlist (azul) e remove owned (já possui)
*/

"use strict";

// Estado em memória da última resposta de /api/games
let PAYLOAD = null;
// Sets de appids do perfil comparado (vazios = sem comparação ativa)
let WISHLIST = new Set();
let OWNED = new Set();
let COMPARE_ACTIVE = false;
// Modo "ver apenas wishlist" (filtro dinâmico após comparar perfil)
let WISHLIST_ONLY = false;
// Última resposta de /api/free-games (carregada sob demanda ao abrir a aba)
let FREE_PAYLOAD = null;

// Por padrão a lista mostra só score CUTOFF–10; o resto fica num "Ver mais".
const SCORE_CUTOFF = 7.0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(msg, cls) {
  const node = el("profile-status");
  node.textContent = msg || "";
  node.className = "profile-status " + (cls || "info");
}

// ─── Render ───────────────────────────────────────────────────────────────────

function gameRow(g, rank, color, isTail) {
  const appid = String(g.appid || "");
  const owned = COMPARE_ACTIVE && OWNED.has(Number(appid));
  if (owned) return ""; // já possui → some da listagem

  const wished = COMPARE_ACTIVE && WISHLIST.has(Number(appid));
  const isNew = !!g.is_new;
  const isLow = !!g.historical_low;

  const classes = [];
  if (isTail) classes.push("tail-row"); // score < CUTOFF → escondida até "Ver mais"
  if (isNew) classes.push("new-row");
  if (isLow) classes.push("hist-low");
  if (wished) classes.push("wishlisted"); // azul vence (vem por último no CSS)
  const trClass = classes.length ? ` class="${classes.join(" ")}"` : "";

  const badges =
    (isNew ? '<span class="new-badge">NEW</span>' : "") +
    (isLow ? '<span class="low-badge">BAIXA HISTÓRICA</span>' : "") +
    (wished ? '<span class="wish-badge">WISHLIST</span>' : "");

  const storeUrl = g.url || `https://store.steampowered.com/app/${appid}/`;
  const imgHtml = g.img_url
    ? `<img src="${escapeHtml(g.img_url)}" alt="" loading="lazy">`
    : "";
  const lowEver = g.low_price_brl || "—";

  return `
    <tr${trClass} data-appid="${escapeHtml(appid)}">
      <td class="rank">${rank}</td>
      <td class="name">
        <a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener">
          ${imgHtml}
          <span>${escapeHtml(g.name)}${badges}</span>
        </a>
      </td>
      <td class="disc" style="color:${color}">-${g.discount}%</td>
      <td class="pct">${g.pct_positive}%</td>
      <td class="reviews">${escapeHtml(g.reviews_human != null ? g.reviews_human : g.total_reviews)}</td>
      <td class="orig">${escapeHtml(g.orig_price || "")}</td>
      <td class="sale">${escapeHtml(g.sale_price || "")}</td>
      <td class="low-ever">${escapeHtml(lowEver)}</td>
      <td class="score">${Number(g.score).toFixed(2)}</td>
    </tr>`;
}

// Renderiza UM bloco (Very Positive, etc.) já com as duas faixas juntas:
//   - score ≥ CUTOFF  → linhas visíveis
//   - score < CUTOFF  → linhas `tail-row` escondidas, reveladas por um botão
//     "Ver mais" NO FIM DAQUELE bloco (tfoot).
// opts.mode === "wishlist" → só jogos da wishlist (qualquer score, sem split).
// Rank = posição por score no bloco inteiro (estável, não depende do filtro).
function blockHtml(block, opts) {
  const color = block.color || "#888";
  const wishlistOnly = opts && opts.mode === "wishlist";
  let topRows = "", tailRows = "";
  let topCount = 0, tailCount = 0;
  let rank = 0;
  for (const g of block.games) {
    rank += 1;
    if (wishlistOnly) {
      if (!WISHLIST.has(Number(g.appid))) continue;
      const r = gameRow(g, rank, color, false);
      if (r) { topRows += r; topCount += 1; }
      continue;
    }
    const isTail = Number(g.score) < SCORE_CUTOFF;
    const r = gameRow(g, rank, color, isTail);
    if (!r) continue;
    if (isTail) { tailRows += r; tailCount += 1; }
    else        { topRows  += r; topCount  += 1; }
  }

  const total = topCount + tailCount;
  if (total === 0) return { html: "", count: 0 };

  // Bloco começa colapsado (tail escondida) quando há jogos abaixo do corte.
  const collapsed = tailCount > 0 ? " tail-collapsed" : "";
  const tfoot = tailCount > 0 ? `
        <tfoot>
          <tr class="tail-toggle-row"><td colspan="9">
            <button class="tail-toggle block-tail-toggle" data-count="${tailCount}" aria-expanded="false">
              ▸ Ver mais ${tailCount} jogos (score abaixo de ${SCORE_CUTOFF})
            </button>
          </td></tr>
        </tfoot>` : "";

  const html = `
    <div class="block${collapsed}">
      <div class="block-header" style="background:${color}">
        <span class="block-name">${escapeHtml(block.name)}</span>
        <span class="block-count">${total} jogos</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Nome</th>
            <th>Desconto</th>
            <th>Review%</th>
            <th>Reviews</th>
            <th>Preço Original</th>
            <th>Preço Promo</th>
            <th>Low Ever (BRL)</th>
            <th>Score ▼</th>
          </tr>
        </thead>
        <tbody>${topRows}${tailRows}
        </tbody>${tfoot}
      </table>
    </div>`;
  return { html, count: total };
}

// ─── Filtros / busca ────────────────────────────────────────────────────────

function collectGames() {
  const out = [];
  for (const block of (PAYLOAD.blocks || [])) {
    for (const g of block.games) out.push({ g, color: block.color || "#888" });
  }
  return out;
}

function filterState() {
  return {
    q:       (((el("f-search")  || {}).value)   || "").trim().toLowerCase(),
    minDisc: Number(((el("f-discount") || {}).value) || 0),
    minPct:  Number(((el("f-review")   || {}).value) || 0),
    sort:    ((el("f-sort")     || {}).value) || "score",
    histOnly: !!((el("f-hist")  || {}).checked),
  };
}

function filtersActive(f) {
  return !!f.q || f.minDisc > 0 || f.minPct > 0 || f.histOnly || f.sort !== "score";
}

function passesFilter(g, f) {
  if (f.q && !String(g.name || "").toLowerCase().includes(f.q)) return false;
  if (f.minDisc && Number(g.discount) < f.minDisc) return false;
  if (f.minPct && Number(g.pct_positive) < f.minPct) return false;
  if (f.histOnly && !g.historical_low) return false;
  return true;
}

// "R$ 1.299,90" → 1299.90 ; vazio/—  → Infinity (cai pro fim no sort asc)
function priceNum(s) {
  let t = String(s || "").replace(/[^\d.,]/g, "");
  if (!t) return Infinity;
  t = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return isNaN(n) ? Infinity : n;
}

function sortGames(arr, sort) {
  const cmp = {
    score:    (a, b) => b.g.score - a.g.score,
    discount: (a, b) => b.g.discount - a.g.discount,
    reviews:  (a, b) => b.g.total_reviews - a.g.total_reviews,
    pct:      (a, b) => (b.g.pct_positive - a.g.pct_positive) ||
                        (b.g.total_reviews - a.g.total_reviews),
    price:    (a, b) => priceNum(a.g.sale_price) - priceNum(b.g.sale_price),
  }[sort] || ((a, b) => b.g.score - a.g.score);
  arr.sort(cmp);
}

const TABLE_HEAD = `
        <thead>
          <tr>
            <th>#</th><th>Nome</th><th>Desconto</th><th>Review%</th>
            <th>Reviews</th><th>Preço Original</th><th>Preço Promo</th>
            <th>Low Ever (BRL)</th><th>Score</th>
          </tr>
        </thead>`;

// Lista plana (resultado de filtros/ordenação): sem split de score, tudo visível.
function flatListHtml(items, label) {
  let rows = "", rank = 0;
  for (const it of items) {
    const r = gameRow(it.g, rank + 1, it.color, false);
    if (r) { rows += r; rank += 1; }
  }
  if (!rows) return "";
  return `
    <div class="block">
      <div class="block-header" style="background:#33455c">
        <span class="block-name">${escapeHtml(label)}</span>
        <span class="block-count">${rank} jogos</span>
      </div>
      <table>${TABLE_HEAD}
        <tbody>${rows}
        </tbody>
      </table>
    </div>`;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderGames() {
  if (!PAYLOAD) return;
  const root = el("games-root");
  const f = filterState();
  const active = filtersActive(f);
  const flat = active || (COMPARE_ACTIVE && WISHLIST_ONLY);

  const fc = el("f-clear");
  if (fc) fc.classList.toggle("hidden", !active);

  // Filtros ativos (ou só-wishlist) → lista plana ordenada, com TUDO que casa.
  if (flat) {
    let items = collectGames().filter(({ g }) => {
      if (COMPARE_ACTIVE && OWNED.has(Number(g.appid))) return false;
      if (COMPARE_ACTIVE && WISHLIST_ONLY && !WISHLIST.has(Number(g.appid))) return false;
      return passesFilter(g, f);
    });
    sortGames(items, f.sort);
    const label = (COMPARE_ACTIVE && WISHLIST_ONLY)
      ? "Sua wishlist em promoção" : "Resultado dos filtros";
    root.innerHTML = flatListHtml(items, label) ||
      '<div class="empty-tier">Nenhum jogo com esses filtros.</div>';
    return;
  }

  // Padrão: blocos por sentimento, score CUTOFF–10 + "Ver mais" por bloco.
  let html = "";
  for (const block of (PAYLOAD.blocks || [])) {
    html += blockHtml(block, { mode: "normal" }).html;
  }
  root.innerHTML = html || '<div class="empty-tier">Nenhum jogo a exibir.</div>';
  root.querySelectorAll(".block-tail-toggle").forEach((btn) => {
    btn.addEventListener("click", toggleBlockTail);
  });
}

// Expande/colapsa as linhas score < CUTOFF DO BLOCO clicado.
function toggleBlockTail(e) {
  const btn = e.currentTarget;
  const block = btn.closest(".block");
  if (!block) return;
  const opened = block.classList.toggle("tail-collapsed") === false;
  btn.setAttribute("aria-expanded", String(opened));
  const n = btn.dataset.count || "";
  btn.textContent = opened
    ? `▾ Ocultar os ${n} jogos com score abaixo de ${SCORE_CUTOFF}`
    : `▸ Ver mais ${n} jogos (score abaixo de ${SCORE_CUTOFF})`;
}

function renderSubtitle() {
  if (!PAYLOAD) return;
  const when = PAYLOAD.generated_at_human || PAYLOAD.generated_at || "—";
  const total = PAYLOAD.total_collected != null ? PAYLOAD.total_collected : "—";
  el("subtitle").textContent = `Gerado em ${when}  —  ${total} jogos coletados`;
}

// ─── Abas + Jogos grátis (Epic) ───────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  el("tab-deals").classList.toggle("hidden", tab !== "deals");
  el("tab-free").classList.toggle("hidden", tab !== "free");
  if (tab === "free" && FREE_PAYLOAD === null) loadFreeGames();
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function freeCard(item, kind) {
  const cover = item.cover
    ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy">`
    : '<div class="free-noimg">🎮</div>';
  const plat = String(item.platform || "epic");
  const platLabel = { epic: "Epic", psn: "PSN", prime: "Prime", gog: "GOG" }[plat] || plat;

  let meta = "";
  if (kind === "current") meta = item.free_until ? "Grátis até " + fmtDate(item.free_until) : "Grátis agora";
  else if (kind === "upcoming") meta = item.free_from ? "Grátis a partir de " + fmtDate(item.free_from) : "Em breve";
  else meta = item.first_seen ? "Foi grátis em " + fmtDate(item.first_seen) : "";

  const orig = item.orig_price
    ? `<span class="free-orig">${escapeHtml(item.orig_price)}</span>` : "";
  const btnLabel = kind === "current" ? "Resgatar grátis" : "Ver na loja";
  const btnCls = kind === "current" ? "free-btn" : "free-btn soon";

  return `
    <div class="free-card ${kind}">
      <a class="free-cover" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
        ${cover}<span class="plat-badge plat-${escapeHtml(plat)}">${escapeHtml(platLabel)}</span>
      </a>
      <div class="free-body">
        <div class="free-title">${escapeHtml(item.title)}</div>
        <div class="free-sub">${escapeHtml(item.seller || "")} ${orig}</div>
        <div class="free-meta">${escapeHtml(meta)}</div>
        <a class="${btnCls}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${btnLabel}</a>
      </div>
    </div>`;
}

function freeSection(title, items, kind) {
  if (!items || !items.length) return "";
  const cards = items.map((it) => freeCard(it, kind)).join("");
  return `<h2 class="free-h2">${title} <span class="free-n">${items.length}</span></h2>
          <div class="free-grid">${cards}</div>`;
}

function renderFree() {
  if (!FREE_PAYLOAD) return;
  el("free-subtitle").textContent =
    "Atualizado em " + (FREE_PAYLOAD.generated_at_human || "—");

  const cur = FREE_PAYLOAD.current || [];
  const up = FREE_PAYLOAD.upcoming || [];
  const curTitles = new Set(cur.map((c) => c.title));
  const hist = (FREE_PAYLOAD.history || []).filter((h) => !curTitles.has(h.title));

  let html = "";
  html += freeSection("🎁 Grátis agora", cur, "current");
  html += freeSection("⏳ Em breve", up, "upcoming");
  html += freeSection("📜 Histórico — já passou", hist, "history");
  el("free-root").innerHTML = html ||
    '<div class="empty-tier">Nenhum jogo grátis no momento. Volte amanhã 🙂</div>';
}

async function loadFreeGames() {
  const loading = el("free-loading");
  try {
    const r = await fetch("/api/free-games", { cache: "no-store" });
    if (r.status === 503) {
      loading.textContent = "Os jogos grátis ainda não foram coletados (aguarde o cron diário).";
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    FREE_PAYLOAD = await r.json();
    loading.classList.add("hidden");
    renderFree();
  } catch (e) {
    loading.textContent = "Falha ao carregar jogos grátis: " + e.message;
  }
}

// ─── Carga inicial ────────────────────────────────────────────────────────────

async function loadGames() {
  try {
    const r = await fetch("/api/games", { cache: "no-store" });
    if (r.status === 503) {
      el("loading").classList.add("hidden");
      const box = el("error-box");
      box.classList.remove("hidden");
      box.textContent =
        "Os dados ainda não foram gerados. Rode o cron: " +
        "python steam_sale_ranker.py 20 --json data/games.json";
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    PAYLOAD = await r.json();
    el("loading").classList.add("hidden");
    renderSubtitle();
    renderGames();
  } catch (e) {
    el("loading").classList.add("hidden");
    const box = el("error-box");
    box.classList.remove("hidden");
    box.textContent = "Falha ao carregar /api/games: " + e.message;
  }
}

// ─── Comparação com perfil ────────────────────────────────────────────────────

async function compareProfile() {
  const raw = el("profile-input").value.trim();
  if (!raw) { setStatus("Digite seu perfil Steam primeiro.", "err"); return; }

  const keyInput = el("apikey-input");
  const apiKey = keyInput ? keyInput.value.trim() : "";

  const btn = el("profile-btn");
  btn.disabled = true;
  setStatus(apiKey ? "Buscando wishlist e biblioteca…" : "Buscando wishlist…", "info");

  try {
    let url = "/api/steam-user?profile=" + encodeURIComponent(raw);
    if (apiKey) url += "&key=" + encodeURIComponent(apiKey);
    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();

    if (!data.ok) {
      setStatus(
        (data.error || "perfil privado ou não encontrado") +
          " — confira se o perfil está público.",
        "err"
      );
      btn.disabled = false;
      return;
    }

    WISHLIST = new Set((data.wishlist || []).map(Number));
    OWNED = new Set((data.owned || []).map(Number));
    COMPARE_ACTIVE = true;
    WISHLIST_ONLY = false;          // sempre começa mostrando tudo
    resetWishlistOnlyBtn();

    renderGames();
    el("clear-btn").classList.remove("hidden");
    // botão de filtro só-wishlist só faz sentido se há wishlist
    el("wishonly-btn").classList.toggle("hidden", WISHLIST.size === 0);

    let msg = `Wishlist: ${WISHLIST.size} jogos (grifados em azul)`;
    msg += OWNED.size
      ? ` · Biblioteca: ${OWNED.size} jogos (ocultados da lista).`
      : ".";
    let cls = "ok";
    if (data.warnings && data.warnings.length) {
      msg += "  Aviso: " + data.warnings.join("; ");
      cls = "warn";
    }
    if (WISHLIST.size === 0 && OWNED.size === 0) {
      msg =
        "Wishlist pública vazia (ou ainda privada). Deixe a lista de desejos " +
        "como Pública em Perfil → Editar perfil → Privacidade.";
      cls = "warn";
    }
    setStatus(msg, cls);
  } catch (e) {
    setStatus("Erro ao consultar o perfil: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function clearProfile() {
  WISHLIST = new Set();
  OWNED = new Set();
  COMPARE_ACTIVE = false;
  WISHLIST_ONLY = false;
  el("clear-btn").classList.add("hidden");
  el("wishonly-btn").classList.add("hidden");
  resetWishlistOnlyBtn();
  setStatus("", "info");
  renderGames();
}

// Botão "ver apenas wishlist" — filtra dinamicamente (re-render, sem nova busca).
function resetWishlistOnlyBtn() {
  const b = el("wishonly-btn");
  if (b) { b.textContent = "★ Ver apenas wishlist"; b.classList.remove("active"); }
}

function toggleWishlistOnly() {
  if (!COMPARE_ACTIVE) return;
  WISHLIST_ONLY = !WISHLIST_ONLY;
  const b = el("wishonly-btn");
  b.textContent = WISHLIST_ONLY ? "✕ Ver todos os jogos" : "★ Ver apenas wishlist";
  b.classList.toggle("active", WISHLIST_ONLY);
  renderGames();
}

function clearFilters() {
  if (el("f-search"))   el("f-search").value = "";
  if (el("f-discount")) el("f-discount").value = "0";
  if (el("f-review"))   el("f-review").value = "0";
  if (el("f-sort"))     el("f-sort").value = "score";
  if (el("f-hist"))     el("f-hist").checked = false;
  renderGames();
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  el("profile-btn").addEventListener("click", compareProfile);
  el("clear-btn").addEventListener("click", clearProfile);
  el("wishonly-btn").addEventListener("click", toggleWishlistOnly);
  el("profile-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") compareProfile();
  });

  setupTabs();
  ["f-search", "f-discount", "f-review", "f-sort", "f-hist"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener(id === "f-search" ? "input" : "change", renderGames);
  });
  if (el("f-clear")) el("f-clear").addEventListener("click", clearFilters);

  loadGames();
});
