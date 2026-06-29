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

function gameRow(g, rank, color) {
  const appid = String(g.appid || "");
  const owned = COMPARE_ACTIVE && OWNED.has(Number(appid));
  if (owned) return ""; // já possui → some da listagem

  const wished = COMPARE_ACTIVE && WISHLIST.has(Number(appid));
  const isNew = !!g.is_new;
  const isLow = !!g.historical_low;

  const classes = [];
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

function blockHtml(block) {
  const color = block.color || "#888";
  let rows = "";
  let rank = 0;
  let visible = 0;
  for (const g of block.games) {
    rank += 1; // rank fixo (posição por score), independe de filtro de owned
    const r = gameRow(g, rank, color);
    if (r) { rows += r; visible += 1; }
  }
  if (visible === 0) return ""; // bloco inteiro filtrado (tudo owned) → oculta

  return `
    <div class="block">
      <div class="block-header" style="background:${color}">
        <span class="block-name">${escapeHtml(block.name)}</span>
        <span class="block-count">${visible} jogos</span>
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
        <tbody>${rows}
        </tbody>
      </table>
    </div>`;
}

function renderGames() {
  if (!PAYLOAD) return;
  const root = el("games-root");
  let html = "";
  for (const block of PAYLOAD.blocks || []) {
    html += blockHtml(block);
  }
  root.innerHTML = html || '<div id="loading">Nenhum jogo a exibir.</div>';
}

function renderSubtitle() {
  if (!PAYLOAD) return;
  const when = PAYLOAD.generated_at_human || PAYLOAD.generated_at || "—";
  const total = PAYLOAD.total_collected != null ? PAYLOAD.total_collected : "—";
  el("subtitle").textContent = `Gerado em ${when}  —  ${total} jogos coletados`;
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

    renderGames();
    el("clear-btn").classList.remove("hidden");

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
  el("clear-btn").classList.add("hidden");
  setStatus("", "info");
  renderGames();
}

// ─── Wire-up ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  el("profile-btn").addEventListener("click", compareProfile);
  el("clear-btn").addEventListener("click", clearProfile);
  el("profile-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") compareProfile();
  });
  loadGames();
});
