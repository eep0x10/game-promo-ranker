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
// Filtros por tag (legenda clicável). "wish" também é o "ver apenas wishlist".
let TAGS = { new: false, hist: false, wish: false };
// Última resposta de /api/free-games (carregada sob demanda ao abrir a aba)
let FREE_PAYLOAD = null;
// Última resposta de /api/epic-games (carregada sob demanda ao abrir a aba)
let EPIC_PAYLOAD = null;
let EPIC_ONLY_CHEAPER = false;

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
// Rank = posição por score no bloco inteiro. (Filtros usam a lista plana.)
function blockHtml(block) {
  const color = block.color || "#888";
  let topRows = "", tailRows = "";
  let topCount = 0, tailCount = 0;
  let rank = 0;
  for (const g of block.games) {
    rank += 1;
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
      <div class="table-scroll"><table>
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
      </table></div>
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
    tagNew:  TAGS.new,
    tagHist: TAGS.hist,
    tagWish: TAGS.wish,
  };
}

function filtersActive(f) {
  return !!f.q || f.minDisc > 0 || f.minPct > 0 || f.sort !== "score" ||
         f.tagNew || f.tagHist || f.tagWish;
}

function passesFilter(g, f) {
  if (f.q && !String(g.name || "").toLowerCase().includes(f.q)) return false;
  if (f.minDisc && Number(g.discount) < f.minDisc) return false;
  if (f.minPct && Number(g.pct_positive) < f.minPct) return false;
  if (f.tagNew && !g.is_new) return false;
  if (f.tagHist && !g.historical_low) return false;
  if (f.tagWish && !(COMPARE_ACTIVE && WISHLIST.has(Number(g.appid)))) return false;
  return true;
}

// Rótulo do cabeçalho da lista plana conforme os filtros ativos.
function flatLabel(f) {
  const onlyTag = !f.q && !f.minDisc && !f.minPct;
  const tags = [f.tagNew && "new", f.tagHist && "hist", f.tagWish && "wish"].filter(Boolean);
  if (onlyTag && tags.length === 1) {
    return { new: "Novidades de hoje", hist: "Baixas históricas",
             wish: "Sua wishlist em promoção" }[tags[0]];
  }
  return "Resultado dos filtros";
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
      <div class="table-scroll"><table>${TABLE_HEAD}
        <tbody>${rows}
        </tbody>
      </table></div>
    </div>`;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderGames() {
  if (!PAYLOAD) return;
  const root = el("games-root");
  const f = filterState();
  const active = filtersActive(f);

  const fc = el("f-clear");
  if (fc) fc.classList.toggle("hidden", !active);

  // Qualquer filtro ativo → lista plana ordenada, com TUDO que casa.
  if (active) {
    let items = collectGames().filter(({ g }) => {
      if (COMPARE_ACTIVE && OWNED.has(Number(g.appid))) return false;
      return passesFilter(g, f);
    });
    sortGames(items, f.sort);
    root.innerHTML = flatListHtml(items, flatLabel(f)) ||
      '<div class="empty-tier">Nenhum jogo com esses filtros.</div>';
    return;
  }

  // Padrão: blocos por sentimento, score CUTOFF–10 + "Ver mais" por bloco.
  let html = "";
  for (const block of (PAYLOAD.blocks || [])) {
    html += blockHtml(block).html;
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
  el("tab-epic").classList.toggle("hidden", tab !== "epic");
  el("tab-free").classList.toggle("hidden", tab !== "free");
  if (tab === "free" && FREE_PAYLOAD === null) loadFreeGames();
  if (tab === "epic" && EPIC_PAYLOAD === null) loadEpicGames();
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

// ─── Promoções Epic ────────────────────────────────────────────────────────────

function epicRow(g, rank) {
  const cover = g.cover
    ? `<img src="${escapeHtml(g.cover)}" alt="" loading="lazy">` : "";
  const badges =
    (g.cheaper_than_steam ? '<span class="cheaper-badge">MAIS BARATO QUE STEAM</span>' : "") +
    (g.on_steam && !g.cheaper_than_steam ? '<span class="onsteam-badge">também na Steam</span>' : "");
  // Coluna Steam: preço comparado (link p/ a página da Steam). Verde se a Epic ganha.
  let steamCell = '<span class="muted">—</span>';
  if (g.on_steam) {
    const cls = g.cheaper_than_steam ? "steam-loses" : "";
    const extra = g.cheaper_than_steam ? ` <span class="save-pct">−${g.steam_save_pct}%</span>` : "";
    steamCell = `<a href="${escapeHtml(g.steam_url || "#")}" target="_blank" rel="noopener" class="${cls}">${escapeHtml(g.steam_price || "")}${extra}</a>`;
  }
  return `
    <tr${g.cheaper_than_steam ? ' class="cheaper-row"' : ""}>
      <td class="rank">${rank}</td>
      <td class="name">
        <a href="${escapeHtml(g.url)}" target="_blank" rel="noopener">
          ${cover}<span>${escapeHtml(g.title)}${badges}</span>
        </a>
      </td>
      <td class="disc" style="color:#f5c518">-${g.discount}%</td>
      <td class="orig">${escapeHtml(g.orig_price || "")}</td>
      <td class="sale">${escapeHtml(g.sale_price || "")}</td>
      <td class="low-ever">${steamCell}</td>
    </tr>`;
}

function epicSort(arr, mode) {
  const cmp = {
    best:     (a, b) => (Number(b.cheaper_than_steam) - Number(a.cheaper_than_steam)) ||
                        (Number(b.on_steam) - Number(a.on_steam)) ||
                        (b.discount - a.discount) || (a.sale_brl - b.sale_brl),
    discount: (a, b) => b.discount - a.discount,
    price:    (a, b) => a.sale_brl - b.sale_brl,
  }[mode] || ((a, b) => 0);
  arr.sort(cmp);
}

function renderEpic() {
  if (!EPIC_PAYLOAD) return;
  el("epic-subtitle").textContent =
    "Atualizado em " + (EPIC_PAYLOAD.generated_at_human || "—") +
    "  —  " + (EPIC_PAYLOAD.total || 0) + " promoções" +
    (EPIC_PAYLOAD.cheaper_than_steam
      ? "  ·  " + EPIC_PAYLOAD.cheaper_than_steam + " mais baratas que na Steam" : "");

  const q = ((el("epic-search") || {}).value || "").trim().toLowerCase();
  const sort = ((el("epic-sort") || {}).value) || "best";
  let games = (EPIC_PAYLOAD.games || []).slice();
  if (EPIC_ONLY_CHEAPER) games = games.filter((g) => g.cheaper_than_steam);
  if (q) games = games.filter((g) => String(g.title || "").toLowerCase().includes(q));
  epicSort(games, sort);

  let rows = "", rank = 0;
  for (const g of games) rows += epicRow(g, ++rank);

  el("epic-root").innerHTML = rows ? `
    <div class="block">
      <div class="block-header" style="background:#2a2a2a">
        <span class="block-name">Promoções Epic</span>
        <span class="block-count">${rank} jogos</span>
      </div>
      <div class="table-scroll"><table>
        <thead><tr>
          <th>#</th><th>Nome</th><th>Desconto</th>
          <th>Preço Original</th><th>Preço Promo</th><th>Steam</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>` : '<div class="empty-tier">Nenhuma promoção com esse filtro.</div>';
}

async function loadEpicGames() {
  const loading = el("epic-loading");
  try {
    const r = await fetch("/api/epic-games", { cache: "no-store" });
    if (r.status === 503) {
      loading.textContent = "As promoções da Epic ainda não foram coletadas (aguarde o cron diário).";
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    EPIC_PAYLOAD = await r.json();
    loading.classList.add("hidden");
    renderEpic();
  } catch (e) {
    loading.textContent = "Falha ao carregar promoções da Epic: " + e.message;
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
    TAGS.wish = false;              // começa mostrando tudo
    syncTagUI();

    el("clear-btn").classList.remove("hidden");
    // botão de filtro só-wishlist só aparece se há wishlist
    el("wishonly-btn").classList.toggle("hidden", WISHLIST.size === 0);
    renderGames();

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
  TAGS.wish = false;             // wishlist sumiu → desliga o filtro de wishlist
  el("clear-btn").classList.add("hidden");
  el("wishonly-btn").classList.add("hidden");
  syncTagUI();
  setStatus("", "info");
  renderGames();
}

// Tags da legenda (new / hist / wish) — filtram dinamicamente (re-render).
function toggleTag(tag) {
  if (tag === "wish" && !COMPARE_ACTIVE) {
    setStatus("Compare seu perfil primeiro para filtrar pela sua wishlist.", "warn");
    return;
  }
  TAGS[tag] = !TAGS[tag];
  syncTagUI();
  renderGames();
}

// Sincroniza o visual: itens da legenda ativos + botão "ver apenas wishlist".
function syncTagUI() {
  document.querySelectorAll(".legend .legend-item").forEach((node) => {
    node.classList.toggle("active", !!TAGS[node.dataset.tag]);
  });
  const wb = el("wishonly-btn");
  if (wb) {
    wb.classList.toggle("active", TAGS.wish);
    wb.textContent = TAGS.wish ? "✕ Ver todos os jogos" : "★ Ver apenas wishlist";
  }
}

function clearFilters() {
  if (el("f-search"))   el("f-search").value = "";
  if (el("f-discount")) el("f-discount").value = "0";
  if (el("f-review"))   el("f-review").value = "0";
  if (el("f-sort"))     el("f-sort").value = "score";
  TAGS.new = TAGS.hist = TAGS.wish = false;
  syncTagUI();
  renderGames();
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  el("profile-btn").addEventListener("click", compareProfile);
  el("clear-btn").addEventListener("click", clearProfile);
  el("wishonly-btn").addEventListener("click", () => toggleTag("wish"));
  el("profile-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") compareProfile();
  });

  setupTabs();
  ["f-search", "f-discount", "f-review", "f-sort"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener(id === "f-search" ? "input" : "change", renderGames);
  });
  if (el("f-clear")) el("f-clear").addEventListener("click", clearFilters);
  document.querySelectorAll(".legend .legend-item").forEach((node) => {
    node.addEventListener("click", () => toggleTag(node.dataset.tag));
  });

  // Filtros da aba Promoções Epic
  ["epic-search", "epic-sort"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener(id === "epic-search" ? "input" : "change", renderEpic);
  });
  const epicToggle = el("epic-cheaper-toggle");
  if (epicToggle) epicToggle.addEventListener("click", () => {
    EPIC_ONLY_CHEAPER = !EPIC_ONLY_CHEAPER;
    epicToggle.classList.toggle("active", EPIC_ONLY_CHEAPER);
    renderEpic();
  });

  loadGames();
});
