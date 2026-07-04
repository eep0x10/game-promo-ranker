#!/usr/bin/env python3
import io, sys
if sys.platform == "win32":
    for _s in ("stdout", "stderr"):
        _cur = getattr(sys, _s)
        if hasattr(_cur, "reconfigure"):
            _cur.reconfigure(encoding="utf-8", errors="replace")

"""
Game Promo Ranker
=================
Lista jogos em promoção na Steam ordenados por score composto.

Fórmula (score normalizado 0–10):
  score = 10 × qualidade × (0.75 + 0.25·fama) × (0.80 + 0.20·desconto)

  - qualidade : limite inferior de Wilson 95% das reviews positivas — junta
                "% positivas" + "nº de reviews" com confiança estatística
                (95% de 200 vale menos que 95% de 200k). Núcleo do score.
  - fama      : log10(reviews) saturando ~100k → modificador suave ×0.75–1.0
  - desconto  : % de desconto → modificador ×0.80–1.0

Blocos seguem a classificação oficial da Steam:
  Overwhelmingly Positive : 95%+  (500+ reviews)
  Very Positive           : 80-94% (500+ reviews)
  Mostly Positive         : 70-79%
  Mixed                   : 40-69%
  Mostly Negative         : 20-39%
  Overwhelmingly Negative : 0-19%  (500+ reviews)

Uso:
  python steam_sale_ranker.py                          # 10 páginas (~500 jogos)
  python steam_sale_ranker.py 20                       # 20 páginas (~1000 jogos)
  python steam_sale_ranker.py 20 --html                # gera steam_sale_ranker.html
  python steam_sale_ranker.py 20 --json data/games.json  # gera JSON p/ a app Flask
"""

import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime

from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("[!] Dependências necessárias:")
    print("    pip install requests beautifulsoup4")
    sys.exit(1)

# ─── Config ──────────────────────────────────────────────────────────────────

STEAM_SEARCH_URL = "https://store.steampowered.com/search/results/"
COUNT_PER_PAGE   = 50
MAX_PER_BLOCK    = 30   # máximo exibido por bloco no terminal
MIN_REVIEWS      = 2000  # jogos com menos reviews são ignorados
MIN_DISCOUNT     = 15    # descontos abaixo disso são ignorados

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) "
        "Gecko/20100101 Firefox/124.0"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://store.steampowered.com/",
}
COOKIES = {
    "birthtime":           "631152001",
    "mature_content":      "1",
    "wants_mature_content": "1",
    "lastagecheckage":     "1-0-2000",
}

# ─── Blocos ──────────────────────────────────────────────────────────────────

BLOCK_ORDER = [
    "Overwhelmingly Positive",
    "Very Positive",
    "Mostly Positive",
    "Mixed",
    "Mostly Negative",
    "Overwhelmingly Negative",
    "Sem Avaliações",
]

BLOCK_COLORS = {
    "Overwhelmingly Positive": "\033[92m",   # verde brilhante
    "Very Positive":           "\033[32m",   # verde
    "Mostly Positive":         "\033[33m",   # amarelo
    "Mixed":                   "\033[93m",   # amarelo brilhante
    "Mostly Negative":         "\033[91m",   # vermelho brilhante
    "Overwhelmingly Negative": "\033[31m",   # vermelho
    "Sem Avaliações":          "\033[90m",   # cinza
}

BLOCK_HEX = {
    "Overwhelmingly Positive": "#4fc24f",
    "Very Positive":           "#66c0f4",
    "Mostly Positive":         "#a4d4a4",
    "Mixed":                   "#f5c518",
    "Mostly Negative":         "#f06c6c",
    "Overwhelmingly Negative": "#c0392b",
    "Sem Avaliações":          "#888",
}

RESET = "\033[0m"
BOLD  = "\033[1m"
GRAY  = "\033[90m"
CYAN  = "\033[96m"

# ─── Score e classificação ────────────────────────────────────────────────────

def calc_score(pct: int, total: int, discount: int) -> float:
    """
    Score 0–10 para destacar BONS NEGÓCIOS (não só jogos caros e famosos).

    Três fatores:
      1) QUALIDADE com confiança — limite inferior de Wilson (95%) da proporção
         de reviews positivas. Junta num só número "% positivas" + "nº de reviews":
         95% de 200 reviews vale MENOS que 95% de 200 000 (menos certeza). Conserta
         o defeito do score antigo, onde % e nº entravam soltos e um jogo nicho com
         poucas reviews podia inflar.
      2) FAMA — log das reviews, saturando ~100k. Modificador suave (×0.75–1.0):
         popularidade conta, mas não domina nem zera um bom jogo.
      3) DESCONTO — modificador ×0.80–1.0 conforme o % de desconto.

    Núcleo = qualidade × 10; fama e desconto só modulam (−25% / −20% no pior caso).
    Ref.: AAA 97% de 500k a 70% off ≈ 9.1 · nicho ótimo 95% de 800 a 75% off ≈ 7.9 ·
    mediano 70% de 2k a 80% off ≈ 6.0.
    """
    if total < 10 or pct <= 0:
        return 0.0
    p = pct / 100.0
    n = float(total)
    z = 1.96  # 95% de confiança
    # Limite inferior de Wilson (0..1) — qualidade já ponderada pela confiança.
    denom   = 1.0 + z * z / n
    centre  = p + z * z / (2.0 * n)
    margin  = z * math.sqrt((p * (1.0 - p) + z * z / (4.0 * n)) / n)
    quality = (centre - margin) / denom
    fame    = min(math.log10(n + 1.0) / 5.0, 1.0)        # satura ~100k reviews
    disc    = max(0, min(discount, 100)) / 100.0
    return 10.0 * quality * (0.75 + 0.25 * fame) * (0.80 + 0.20 * disc)


def review_block(pct: int, total: int) -> str:
    """Classifica o jogo no bloco correto conforme o sistema Steam."""
    if total < 10:
        return "Sem Avaliações"
    if total >= 500:
        if pct >= 95: return "Overwhelmingly Positive"
        if pct >= 80: return "Very Positive"
        if pct < 20:  return "Overwhelmingly Negative"
    if pct >= 70: return "Mostly Positive"
    if pct >= 40: return "Mixed"
    return "Mostly Negative"

# ─── Coleta ───────────────────────────────────────────────────────────────────

def fetch_page(start: int, sort_by: str = "Reviews_DESC") -> tuple[list[dict], int]:
    """Busca uma página do search da Steam. Retorna (jogos_parsed, total_count)."""
    params = {
        "specials": 1,
        "json":     1,
        "count":    COUNT_PER_PAGE,
        "start":    start,
        "infinite": 1,
    }
    if sort_by:
        params["sort_by"] = sort_by
    resp = requests.get(
        STEAM_SEARCH_URL,
        params=params,
        headers=HEADERS,
        cookies=COOKIES,
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()

    total = int(data.get("total_count", 0))

    # A Steam retorna HTML no items_html ou results_html
    raw_html = (
        data.get("items_html")
        or data.get("results_html")
        or ""
    )
    if not raw_html:
        # Fallback: items como lista de strings
        items = data.get("items", [])
        if isinstance(items, list):
            raw_html = "\n".join(str(x) for x in items)

    soup  = BeautifulSoup(raw_html, "html.parser")
    rows  = soup.find_all("a", class_="search_result_row")
    games = [g for r in rows if (g := _parse_row(r)) is not None]
    return games, total


def _parse_row(row) -> dict | None:
    """Extrai metadados de um search_result_row."""
    try:
        # ── Nome ──────────────────────────────────────────────────────────
        name_tag = row.find("span", class_="title")
        name = name_tag.get_text(strip=True) if name_tag else "?"

        appid = row.get("data-ds-appid", "").split(",")[0]

        # ── Desconto ──────────────────────────────────────────────────────
        discount = 0

        # Tentativa 1: atributo data-ds-discount
        if row.get("data-ds-discount"):
            try:
                discount = int(row["data-ds-discount"])
            except ValueError:
                pass

        # Tentativa 2: div.search_discount > span
        if discount == 0:
            disc_tag = row.find("div", class_="search_discount")
            if disc_tag:
                m = re.search(r"(\d+)%", disc_tag.get_text())
                if m:
                    discount = int(m.group(1))

        # Tentativa 3: div.discount_pct
        if discount == 0:
            disc_tag = row.find("div", class_="discount_pct")
            if disc_tag:
                m = re.search(r"(\d+)", disc_tag.get_text())
                if m:
                    discount = int(m.group(1))

        if discount < MIN_DISCOUNT:
            return None

        # ── Preços ────────────────────────────────────────────────────────
        orig_price = ""
        sale_price = ""

        orig_tag = row.find(class_="discount_original_price")
        sale_tag = row.find(class_="discount_final_price")
        if orig_tag:
            orig_price = orig_tag.get_text(strip=True)
        if sale_tag:
            sale_price = sale_tag.get_text(strip=True)

        # Fallback: search_price genérico
        if not sale_price:
            price_block = row.find("div", class_="search_price")
            if price_block:
                strike = price_block.find("strike")
                if strike:
                    orig_price = strike.get_text(strip=True)
                texts = [t.strip() for t in price_block.get_text("\n").split("\n") if t.strip()]
                if texts:
                    sale_price = texts[-1]

        # ── Reviews ───────────────────────────────────────────────────────
        pct_positive  = 0
        total_reviews = 0

        review_span = row.find("span", class_="search_review_summary")
        if review_span:
            tooltip = review_span.get("data-tooltip-html", "")
            # "94% of 28,521 user reviews for this game are positive."
            # "94% das 28.521 análises dos usuários recomendam este jogo."
            m_pct = re.search(r"(\d+)%", tooltip)
            m_tot = re.search(
                r"([\d,\.]+)\s*(user reviews|análises|reviews)",
                tooltip, re.IGNORECASE
            )
            if m_pct:
                pct_positive = int(m_pct.group(1))
            if m_tot:
                total_reviews = int(re.sub(r"[,\.]", "", m_tot.group(1)))

        if total_reviews < MIN_REVIEWS:
            return None

        # ── Imagem ────────────────────────────────────────────────────────
        img_url = ""
        img_tag = row.find("div", class_="search_capsule")
        if img_tag:
            img_el = img_tag.find("img")
            if img_el:
                img_url = img_el.get("src", "")
        if not img_url and appid:
            img_url = f"https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/capsule_231x87.jpg"

        # Capa larga (460x215) para a visão em cards do frontend.
        header_img = (f"https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg"
                      if appid else "")

        return {
            "name":          name,
            "appid":         appid,
            "discount":      discount,
            "pct_positive":  pct_positive,
            "total_reviews": total_reviews,
            "orig_price":    orig_price,
            "sale_price":    sale_price,
            "score":         calc_score(pct_positive, total_reviews, discount),
            "block":         review_block(pct_positive, total_reviews),
            "url":           row.get("href", f"https://store.steampowered.com/app/{appid}/"),
            "img_url":       img_url,
            "header_img":    header_img,
        }
    except Exception:
        return None

# ─── Coleta com paginação ─────────────────────────────────────────────────────

# Duas passagens para cobrir jogos diferentes:
# Reviews_DESC → jogos populares (muitos reviews, desconto variado)
# sem sort     → relevância Steam para promoções (tende a priorizar descontos maiores)
FETCH_STRATEGIES = ["Reviews_DESC", ""]

def _fetch_strategy(sort_by: str, max_pages: int, label: str) -> tuple[list[dict], int]:
    games: list[dict] = []
    total_available = 0
    for page in range(max_pages):
        start = page * COUNT_PER_PAGE
        print(f"\r  {label} [{page + 1}/{max_pages}] offset={start}...", end="", flush=True)
        try:
            batch, total = fetch_page(start, sort_by=sort_by)
            total_available = total
            if not batch:
                break
            games.extend(batch)
            if start + COUNT_PER_PAGE >= total:
                break
            time.sleep(0.3)
        except requests.HTTPError as e:
            print(f"\n[!] HTTP {e.response.status_code}")
            break
        except Exception as e:
            print(f"\n[!] Erro: {e}")
            break
    return games, total_available


def collect_all(max_pages: int) -> list[dict]:
    seen:      set[str]   = set()
    all_games: list[dict] = []
    total_available = 0

    for i, sort_by in enumerate(FETCH_STRATEGIES):
        label = f"[pass {i+1}/{len(FETCH_STRATEGIES)} {'reviews' if sort_by else 'relevância'}]"
        batch, total = _fetch_strategy(sort_by, max_pages, label)
        total_available = max(total_available, total)
        new = 0
        for g in batch:
            if g["appid"] not in seen:
                seen.add(g["appid"])
                all_games.append(g)
                new += 1
        print(f"\r  pass {i+1}: +{new} novos (total único: {len(all_games)})          ")

    print(f"  Total disponível na Steam: ~{total_available} jogos em promoção")
    return all_games


# ─── Baixa histórica (CheapShark) ─────────────────────────────────────────────
# Estratégia: 2 chamadas por jogo
#   1. GET /games?steamAppID={appid}  → {gameID, cheapest_usd_ever}
#   2. GET /games?id={gameID}         → {cheapestPriceEver.price, deals[storeID=1].price}
# Rate limit: lock compartilhado garante ≤ 4.5 req/s (não estourar o CheapShark)

import threading as _threading

# CheapShark storeID → nome. O mesmo /games?id= que consultamos p/ a baixa já traz
# TODAS as lojas em `deals`, então cruzar preços multi-loja sai "de graça" (reuso).
CS_STORES = {
    "1": "Steam", "3": "GreenManGaming", "7": "GOG", "11": "Humble",
    "15": "Fanatical", "25": "Epic", "27": "Gamesplanet", "13": "Ubisoft",
    "23": "GameBillet", "24": "Voidu", "30": "IndieGala", "35": "DreamGame",
}
# Só surfaçamos lojas "confiáveis" (chave oficial p/ Steam) na comparação.
CS_STORES_SHOW = {"1", "3", "7", "11", "15", "25", "27"}

_cs_lock       = _threading.Lock()
_cs_last_call  = [0.0]
_CS_INTERVAL   = 0.5    # 2 req/s — seguro para uso diário
# CheapShark bloqueia o IP em rajada grande. Por isso semeamos um LOTE pequeno por
# execução (o cron diário enche aos poucos), com backoff curto e um circuit breaker
# que desliga o resto do lote quando detecta bloqueio (evita travar o cron).
SEED_BATCH     = 120
_cs_blocked    = [False]   # circuit breaker do run atual
_cs_streak     = [0]       # 429 consecutivos


def _cs_get(path: str, params: dict, _retry: int = 1) -> any:
    """GET ao CheapShark com rate limiting, backoff curto e circuit breaker."""
    if _cs_blocked[0]:           # bloqueio já detectado neste run → não insiste
        return None
    with _cs_lock:
        gap = _CS_INTERVAL - (time.time() - _cs_last_call[0])
        if gap > 0:
            time.sleep(gap)
        _cs_last_call[0] = time.time()
    try:
        r = requests.get(
            f"https://www.cheapshark.com/api/1.0{path}",
            params=params, timeout=10,
        )
        if r.status_code == 429:
            _cs_streak[0] += 1
            if _cs_streak[0] >= 12:          # IP bloqueado → desliga o resto do lote
                _cs_blocked[0] = True
            if _retry > 0 and not _cs_blocked[0]:
                time.sleep(8)                # backoff curto
                return _cs_get(path, params, _retry=_retry - 1)
            return None
        if r.status_code == 200:
            _cs_streak[0] = 0                 # sucesso reseta a sequência de 429
            return r.json()
        return None
    except Exception:
        return None


def _parse_brl(price_str: str) -> float:
    """Extrai valor numérico de 'R$ 9,99' ou 'R$9.99'. Retorna 0.0 se falhar."""
    try:
        s = re.sub(r"[R$\s]", "", price_str)   # remove R$, espaços
        s = s.replace(".", "").replace(",", ".")  # "9.999,99" → "9999.99"
        return float(s)
    except Exception:
        return 0.0


def _fmt_brl(value: float) -> str:
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# Cache persistente de baixa histórica (vive no volume data/, ao lado de games.json).
# Estrutura: { appid: {low_brl: float, low_str: "R$ ...", src: "cs"|"obs",
#                       beaten: bool, updated: ISO} }
# - "cs"  : baixa semeada do CheapShark (cheapestPriceEver convertido p/ BRL)
# - "obs" : sem dado no CheapShark — assumimos o preço observado como baixa conhecida
# - beaten: já vimos o preço cair abaixo do valor inicial (confirma drop real)
HIST_CACHE_NAME = "historical_lows.json"


def _load_low_cache(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_low_cache(path: str, cache: dict) -> None:
    try:
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except Exception:
        pass


def _best_deals_by_store(deals: list) -> list[dict]:
    """Menor deal por loja (só as lojas em CS_STORES_SHOW). Preço em USD (crú)."""
    best: dict[str, dict] = {}
    for d in deals or []:
        sid = str(d.get("storeID"))
        if sid not in CS_STORES_SHOW:
            continue
        try:
            price = float(d.get("price", 0))
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        cur = best.get(sid)
        if cur is None or price < cur["price_usd"]:
            best[sid] = {
                "store":     CS_STORES.get(sid, "Loja"),
                "price_usd": price,
                "url":       (f"https://www.cheapshark.com/redirect?dealID={d.get('dealID')}"
                              if d.get("dealID") else ""),
            }
    return list(best.values())


def _check_one_low(game: dict) -> tuple[str, bool, float, float, list]:
    """
    Retorna (appid, is_historical_low, cheapest_ever_usd, current_usd, stores_usd).
    A conversão para BRL é feita no chamador usando o preço BRL do jogo. `stores_usd`
    é a lista de menores deals por loja (Steam/GOG/Fanatical/…), preços em USD.
    """
    appid = game["appid"]
    try:
        step1 = _cs_get("/games", {"steamAppID": appid})
        if not step1 or not isinstance(step1, list) or not step1:
            return appid, False, 0.0, 0.0, []
        game_id = step1[0].get("gameID", "")
        if not game_id:
            return appid, False, 0.0, 0.0, []

        step2 = _cs_get("/games", {"id": game_id})
        if not step2 or not isinstance(step2, dict):
            return appid, False, 0.0, 0.0, []

        deals = step2.get("deals", []) or []
        stores_usd = _best_deals_by_store(deals)

        cheapest_str = step2.get("cheapestPriceEver", {}).get("price", "")
        if not cheapest_str:
            return appid, False, 0.0, 0.0, stores_usd
        cheapest_ever = float(cheapest_str)
        if cheapest_ever <= 0:
            return appid, False, 0.0, 0.0, stores_usd

        steam_deal = next(
            (d for d in deals if str(d.get("storeID")) == "1"),
            None,
        )
        if not steam_deal:
            return appid, False, cheapest_ever, 0.0, stores_usd

        current_usd = float(steam_deal.get("price", 0))
        is_low = current_usd > 0 and current_usd <= cheapest_ever * 1.02
        return appid, is_low, cheapest_ever, current_usd, stores_usd
    except Exception:
        return appid, False, 0.0, 0.0, []


def apply_low_cache(games: list[dict], cache_path: str) -> None:
    """
    Aplica o CACHE de baixa histórica a TODOS os jogos (preenche
    game['low_price_brl'] e game['historical_low']) — SEM rede. Rápido.

    A baixa só muda quando o preço atual SUPERA o recorde (preço < baixa
    conhecida): aí o próprio preço atual vira a nova baixa (sem reconsultar o
    CheapShark) e é gravado na hora. Chamado na fase 1 (publica já o que está
    cacheado) e de novo na fase 2 (após semear os novos).
    """
    cache = _load_low_cache(cache_path)
    now_iso = datetime.now().isoformat(timespec="seconds")
    records = obs_new = 0
    dirty = False
    for g in games:
        appid = g.get("appid", "")
        ent = cache.get(appid)
        cur_brl = _parse_brl(g.get("sale_price", ""))

        if ent is not None and ent.get("src") == "cs":
            # Baixa VERIFICADA do CheapShark (recorde de todos os tempos).
            low_brl = float(ent.get("low_brl") or 0.0)
            # Novo recorde: preço atual abaixo da baixa → vira a nova baixa.
            if cur_brl > 0 and (low_brl <= 0 or cur_brl < low_brl - 0.005):
                low_brl = cur_brl
                ent.update(low_brl=round(low_brl, 2), low_str=_fmt_brl(low_brl),
                           beaten=True, updated=now_iso)
                records += 1
                dirty = True
            g["low_price_brl"] = ent.get("low_str") or (_fmt_brl(low_brl) if low_brl > 0 else "")
            g["low_src"] = "cs"
            g["historical_low"] = bool(cur_brl > 0 and low_brl > 0 and cur_brl <= low_brl * 1.02)
            g["stores"] = ent.get("stores") or []
            continue

        # ── Fallback OBSERVADO: sem dado do CheapShark ainda → mostra o MENOR
        #    preço que já observamos (e vai baixando dia a dia). Garante que todo
        #    jogo tenha um valor, não "—". Vira "cs" quando o seeding conseguir. ──
        if cur_brl <= 0:
            g["historical_low"] = False
            g["low_price_brl"] = ""
            g["low_src"] = ""
            continue
        if ent is None:
            ent = {"low_brl": round(cur_brl, 2), "low_str": _fmt_brl(cur_brl),
                   "src": "obs", "beaten": False, "updated": now_iso}
            cache[appid] = ent
            obs_new += 1
            dirty = True
        else:
            low_brl = float(ent.get("low_brl") or 0.0)
            if low_brl <= 0 or cur_brl < low_brl - 0.005:   # novo menor observado
                ent.update(low_brl=round(cur_brl, 2), low_str=_fmt_brl(cur_brl),
                           beaten=(low_brl > 0), updated=now_iso)
                dirty = True
        low_brl = float(ent.get("low_brl") or 0.0)
        g["low_price_brl"] = ent.get("low_str") or ""
        g["low_src"] = "obs"
        # ★ só quando houve queda REAL observada (beaten) e está no menor agora.
        g["historical_low"] = bool(cur_brl > 0 and low_brl > 0 and ent.get("beaten")
                                   and cur_brl <= low_brl * 1.02)

    if dirty:
        _save_low_cache(cache_path, cache)
    have = sum(1 for g in games if g.get("low_price_brl"))
    cs_n = sum(1 for g in games if g.get("low_src") == "cs")
    print(f"  Baixa histórica: {have}/{len(games)} com valor ({cs_n} CheapShark · "
          f"{have - cs_n} observadas) · {records} recordes novos · {obs_new} obs novas · "
          f"{len(cache)} no cache.")


def seed_low_cache(games: list[dict], cache_path: str) -> None:
    """
    Semeia o cache de baixa histórica APENAS para os jogos ainda não cacheados,
    via CheapShark (lento). Grava cada baixa na hora → ao vivo e RESUMÍVEL: um
    timeout no meio não perde o progresso, a próxima execução continua de onde
    parou. Após o primeiro seeding completo, o custo externo cai a ~zero.
    """
    cache = _load_low_cache(cache_path)
    # Verifica o que falta E o que está como "obs" (baixa não-verificada de runs
    # antigas em que o CheapShark falhou): só confiamos em baixa REAL (src="cs").
    # Também re-verifica jogos já "cs" que ainda não tiveram as LOJAS coletadas
    # (feature nova) — uma vez só, marcado por "stores_checked".
    def _needs(g):
        ent = cache.get(g.get("appid"), {})
        return ent.get("src") != "cs" or not ent.get("stores_checked")
    needs = [g for g in games if g.get("appid") and _needs(g)]
    if not needs:
        print("  Baixa histórica: cache cobre todos os jogos (0 chamadas externas).")
        return
    total = len(needs)
    needs = needs[:SEED_BATCH]           # lote pequeno → não toma block do CheapShark
    n = len(needs)
    print(f"  Baixa histórica: verificando {n}/{total} jogos no CheapShark "
          f"(lote diário; o resto vem nas próximas execuções)...")
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(_check_one_low, g): g for g in needs}
        done = 0
        for fut in as_completed(futures):
            g = futures[fut]
            _appid, _is_low, cheapest_usd, current_usd, stores_usd = fut.result()
            brl_val = _parse_brl(g.get("sale_price", ""))
            ratio = (brl_val / current_usd) if (brl_val > 0 and current_usd > 0) else 0.0

            # Preços multi-loja convertidos p/ BRL pelo mesmo ratio da baixa (USD→BRL).
            stores_brl = []
            if ratio > 0 and stores_usd:
                for s in stores_usd:
                    pbrl = round(s["price_usd"] * ratio, 2)
                    stores_brl.append({"store": s["store"], "price": _fmt_brl(pbrl),
                                       "price_brl": pbrl, "url": s.get("url", "")})
                stores_brl.sort(key=lambda x: x["price_brl"])
                for i, s in enumerate(stores_brl):
                    s["best"] = (i == 0)

            # Só grava baixa VERIFICADA do CheapShark. Sem dado/erro (429) → NÃO
            # cacheia (mostra "—" e tenta de novo na próxima execução). Nada de
            # "obs" (preço atual fingindo de baixa histórica).
            if cheapest_usd > 0 and ratio > 0:
                low_brl = cheapest_usd * ratio
                cache[g["appid"]] = {
                    "low_brl": round(low_brl, 2),
                    "low_str": _fmt_brl(low_brl),
                    "src":     "cs",
                    "beaten":  False,
                    "stores":  stores_brl,
                    "stores_checked": True,
                    "updated": datetime.now().isoformat(timespec="seconds"),
                }
                _save_low_cache(cache_path, cache)   # grava cada baixa na hora → resumível
            elif ratio > 0 and cache.get(g["appid"], {}).get("src") == "cs":
                # Já tínhamos a baixa cs; só faltavam as lojas → completa sem re-baixar.
                cache[g["appid"]]["stores"] = stores_brl
                cache[g["appid"]]["stores_checked"] = True
                _save_low_cache(cache_path, cache)
            done += 1
            print(f"\r  CheapShark: {done}/{n}...", end="", flush=True)
    print()

# ─── Metadados: gênero / tags / Steam Deck (Steam appdetails) ─────────────────
# Enriquece cada jogo com gêneros, algumas tags de jogabilidade e a compatibilidade
# com o Steam Deck. Como o appdetails é bem rate-limited, semeamos um LOTE pequeno
# por execução e cacheamos em meta_cache.json (gênero nunca muda; Deck quase nunca).
META_CACHE_NAME = "meta_cache.json"
META_BATCH      = 80
META_INTERVAL   = 1.5          # ~40 req/min — gentil com o appdetails da Steam

# Categorias (multiplayer) que viram "tag" de jogabilidade além do gênero.
_CAT_KEEP = {"Co-op", "Online Co-op", "Local Co-op", "Multi-player",
             "PvP", "Massively Multiplayer"}
# resolved_category do relatório de Deck → rótulo do frontend.
_DECK_MAP = {0: "unknown", 1: "unsupported", 2: "playable", 3: "verified"}

_meta_lock    = _threading.Lock()
_meta_last    = [0.0]
_meta_blocked = [False]
_meta_streak  = [0]


def _steam_get(url: str, params: dict):
    """GET a um endpoint da store da Steam com rate limit + circuit breaker (429)."""
    if _meta_blocked[0]:
        return None
    with _meta_lock:
        gap = META_INTERVAL - (time.time() - _meta_last[0])
        if gap > 0:
            time.sleep(gap)
        _meta_last[0] = time.time()
    try:
        r = requests.get(url, params=params, headers=HEADERS, cookies=COOKIES, timeout=15)
        if r.status_code == 429:
            _meta_streak[0] += 1
            if _meta_streak[0] >= 5:
                _meta_blocked[0] = True
            return None
        if r.status_code == 200:
            _meta_streak[0] = 0
            return r.json()
        return None
    except Exception:
        return None


def _fetch_meta_one(appid: str) -> dict | None:
    """Busca gêneros/tags (appdetails) + Deck (relatório de compat). None se falhar."""
    d = _steam_get("https://store.steampowered.com/api/appdetails",
                   {"appids": appid, "cc": "br", "l": "portuguese"})
    node = (d or {}).get(str(appid)) if isinstance(d, dict) else None
    if not node or not node.get("success"):
        return None
    data = node.get("data") or {}
    genres = [g.get("description") for g in (data.get("genres") or []) if g.get("description")][:4]
    cats   = [c.get("description") for c in (data.get("categories") or []) if c.get("description")]
    tags   = []
    for t in genres[:3] + [c for c in cats if c in _CAT_KEEP]:
        if t and t not in tags:
            tags.append(t)
    tags = tags[:4]

    deck = "unknown"
    dj = _steam_get("https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport",
                    {"nAppID": appid, "l": "english"})
    if isinstance(dj, dict):
        cat = (dj.get("results") or {}).get("resolved_category")
        if isinstance(cat, int):
            deck = _DECK_MAP.get(cat, "unknown")
    return {"genres": genres, "tags": tags, "deck": deck,
            "updated": datetime.now().isoformat(timespec="seconds")}


def apply_meta_cache(games: list[dict], cache_path: str) -> None:
    """Aplica o cache de metadados a TODOS os jogos (sem rede)."""
    cache = _load_low_cache(cache_path)   # mesmo helper de I/O de JSON
    for g in games:
        ent = cache.get(g.get("appid", ""))
        if isinstance(ent, dict):
            g["genres"] = ent.get("genres") or []
            g["tags"]   = ent.get("tags") or []
            g["deck"]   = ent.get("deck") or "unknown"


def seed_meta_cache(games: list[dict], cache_path: str) -> None:
    """Semeia metadados p/ os jogos ainda não cacheados (lote pequeno, resumível)."""
    cache = _load_low_cache(cache_path)
    needs = [g for g in games if g.get("appid") and g["appid"] not in cache]
    if not needs:
        print("  Metadados: cache cobre todos os jogos (0 chamadas externas).")
        return
    total = len(needs)
    needs = needs[:META_BATCH]
    print(f"  Metadados: buscando {len(needs)}/{total} jogos (gênero/tags/Deck; "
          f"lote diário, o resto vem depois)...")
    done = 0
    for g in needs:
        if _meta_blocked[0]:
            print("\n  [!] appdetails limitou o IP — para o lote (continua amanhã).")
            break
        meta = _fetch_meta_one(g["appid"])
        if meta:
            cache[g["appid"]] = meta
            _save_low_cache(cache_path, cache)   # grava na hora → resumível
        done += 1
        print(f"\r  appdetails: {done}/{len(needs)}...", end="", flush=True)
    print()


# ─── Histórico de preço (série diária, acumulada) ─────────────────────────────
# Sem fonte pública de histórico Steam sem API key; então acumulamos 1 ponto/dia
# (o preço promocional observado) em price_series.json. A sparkline enche com o
# tempo — honesto, no mesmo espírito da baixa "observada".
PRICE_SERIES_NAME = "price_series.json"
PRICE_SERIES_MAX  = 24


def record_price_history(games: list[dict], path: str) -> None:
    """Anexa o ponto de hoje (preço promo) por jogo e expõe g['price_history']."""
    series = _load_low_cache(path)
    today = datetime.now().strftime("%Y-%m-%d")
    dirty = False
    for g in games:
        appid = g.get("appid", "")
        p = _parse_brl(g.get("sale_price", ""))
        if not appid or p <= 0:
            continue
        pts = series.get(appid)
        if not isinstance(pts, list):
            pts = []
        if pts and pts[-1].get("d") == today:
            if abs(float(pts[-1].get("p", 0)) - p) > 0.005:
                pts[-1]["p"] = round(p, 2)
                dirty = True
        else:
            pts.append({"d": today, "p": round(p, 2)})
            dirty = True
        if len(pts) > PRICE_SERIES_MAX:
            pts = pts[-PRICE_SERIES_MAX:]
            dirty = True
        series[appid] = pts
        g["price_history"] = pts
    if dirty:
        _save_low_cache(path, series)


def apply_price_history(games: list[dict], path: str) -> None:
    """Anexa a série já existente aos jogos (sem gravar) — usado na fase 1."""
    series = _load_low_cache(path)
    for g in games:
        pts = series.get(g.get("appid", ""))
        if isinstance(pts, list):
            g["price_history"] = pts


# ─── Output terminal ──────────────────────────────────────────────────────────

def fmt_num(n: int) -> str:
    if n >= 1_000_000: return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:     return f"{n / 1_000:.0f}k"
    return str(n)


def print_results(by_block: dict[str, list[dict]], total_collected: int):
    W = 75

    print(f"\n{BOLD}{CYAN}{'═' * W}")
    print(f"  GAME PROMO RANKER  —  {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print(f"  Score 0-10 = qualidade(Wilson) × fama(log reviews) × bonus desconto")
    print(f"  Quanto maior, melhor a relação qualidade + fama + desconto")
    print(f"{'═' * W}{RESET}\n")

    total_shown = 0
    for block_name in BLOCK_ORDER:
        games = by_block.get(block_name, [])
        if not games:
            continue

        color = BLOCK_COLORS[block_name]
        print(f"\n{color}{BOLD}{'═' * W}")
        print(f"  {block_name.upper()}  ({len(games)} jogos encontrados)")
        print(f"{'═' * W}{RESET}")

        print(
            f"{GRAY}{'#':>3}  {'Nome':<39} {'Desc':>5}  "
            f"{'Rev%':>4}  {'Reviews':>7}  {'Low Ever (BRL)':>14}  {'Score':>6}{RESET}"
        )
        print(f"{GRAY}{'─' * W}{RESET}")

        top = games[:MAX_PER_BLOCK]
        for i, g in enumerate(top, 1):
            is_low   = g.get("historical_low", False)
            row_col   = "\033[92m" if is_low else ""
            low_tag   = f" {BOLD}\033[92m★{RESET}" if is_low else ""
            low_brl   = g.get("low_price_brl", "")
            low_col   = "\033[92m" if is_low else "\033[90m"
            low_str   = f"{low_col}{low_brl if low_brl else '—':>12}{RESET}"
            disc_str  = f"{color}-{g['discount']}%{RESET}"
            name_str  = g["name"][:38].ljust(38)
            print(
                f"{row_col}{i:>3}  {name_str}{low_tag} "
                f"{disc_str}  "
                f"{g['pct_positive']:>3}%  "
                f"{fmt_num(g['total_reviews']):>7}  "
                f"{low_str}  "
                f"{g['score']:>6.2f}{RESET}"
            )
            total_shown += 1

        extra = len(games) - MAX_PER_BLOCK
        if extra > 0:
            print(f"{GRAY}  ... +{extra} jogos omitidos (use --html para ver todos){RESET}")

    omitted = total_collected - total_shown
    print(f"\n{BOLD}Exibidos: {total_shown}  |  Total coletado: {total_collected}{RESET}")
    if omitted > 0:
        print(f"{GRAY}Use --html para relatório completo.{RESET}")

# ─── Output HTML ──────────────────────────────────────────────────────────────

def generate_html(by_block: dict[str, list[dict]], total_collected: int) -> str:
    now = datetime.now().strftime("%d/%m/%Y %H:%M")

    rows_by_block = ""
    for block_name in BLOCK_ORDER:
        games = by_block.get(block_name, [])
        if not games:
            continue
        hex_color = BLOCK_HEX[block_name]
        rows_html = ""
        for i, g in enumerate(games, 1):
            store_url = g.get("url", f"https://store.steampowered.com/app/{g['appid']}/")
            img_url   = g.get("img_url", "")
            img_html  = (
                f'<img src="{img_url}" alt="" loading="lazy">'
                if img_url else ""
            )
            is_low   = g.get("historical_low", False)
            is_new   = g.get("is_new", False)
            _cls     = (["new-row"] if is_new else []) + (["hist-low"] if is_low else [])
            tr_class = (' class="' + " ".join(_cls) + '"') if _cls else ""
            low_badge = (('<span class="new-badge">NEW</span>' if is_new else "")
                         + ('<span class="low-badge">BAIXA HISTÓRICA</span>' if is_low else ""))
            rows_html += f"""
              <tr{tr_class}>
                <td class="rank">{i}</td>
                <td class="name">
                  <a href="{store_url}" target="_blank">
                    {img_html}
                    <span>{g['name']}{low_badge}</span>
                  </a>
                </td>
                <td class="disc" style="color:{hex_color}">-{g['discount']}%</td>
                <td class="pct">{g['pct_positive']}%</td>
                <td class="reviews">{fmt_num(g['total_reviews'])}</td>
                <td class="orig">{g['orig_price']}</td>
                <td class="sale">{g['sale_price']}</td>
                <td class="low-ever">{g.get('low_price_brl') or '—'}</td>
                <td class="score">{g['score']:.2f}</td>
              </tr>"""

        rows_by_block += f"""
        <div class="block">
          <div class="block-header" style="background:{hex_color}">
            <span class="block-name">{block_name}</span>
            <span class="block-count">{len(games)} jogos</span>
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
            <tbody>{rows_html}
            </tbody>
          </table>
        </div>"""

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Promo Ranker</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: "Segoe UI", sans-serif;
      background: #1b2838;
      color: #c6d4df;
      padding: 20px;
    }}
    h1 {{
      color: #66c0f4;
      font-size: 1.6rem;
      margin-bottom: 6px;
    }}
    .subtitle {{
      color: #8f98a0;
      font-size: 0.85rem;
      margin-bottom: 24px;
    }}
    .formula {{
      background: #16202d;
      border-left: 3px solid #66c0f4;
      padding: 8px 14px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.9rem;
      color: #c7d5e0;
      margin-bottom: 28px;
      display: inline-block;
    }}
    .block {{
      margin-bottom: 32px;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }}
    .block-header {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 16px;
      color: #fff;
    }}
    .block-name {{ font-weight: 700; font-size: 1rem; }}
    .block-count {{ font-size: 0.82rem; opacity: 0.85; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      background: #16202d;
      font-size: 0.83rem;
    }}
    thead th {{
      background: #0e1822;
      padding: 7px 10px;
      text-align: left;
      color: #8f98a0;
      font-weight: 600;
      white-space: nowrap;
    }}
    tbody tr:nth-child(even) {{ background: #1a2535; }}
    tbody tr:hover {{ background: #2a3f5a; }}
    td {{ padding: 5px 10px; vertical-align: middle; }}
    td.rank  {{ color: #8f98a0; width: 36px; text-align: right; }}
    td.name  {{ min-width: 260px; }}
    td.name a {{
      display: flex;
      align-items: center;
      gap: 10px;
      color: #c6d4df;
      text-decoration: none;
    }}
    td.name a:hover span {{ color: #66c0f4; text-decoration: underline; }}
    td.name img {{
      width: 116px;
      height: 43px;
      object-fit: cover;
      border-radius: 3px;
      flex-shrink: 0;
      background: #0e1822;
    }}
    td.name span {{
      font-size: 0.84rem;
      line-height: 1.3;
    }}
    td.disc  {{ font-weight: 700; width: 70px; white-space: nowrap; }}
    td.pct   {{ width: 55px; white-space: nowrap; }}
    td.reviews {{ width: 75px; color: #8f98a0; white-space: nowrap; }}
    td.orig  {{ width: 105px; color: #8f98a0; text-decoration: line-through; white-space: nowrap; }}
    td.sale      {{ width: 105px; font-weight: 600; color: #beee11; white-space: nowrap; }}
    td.low-ever  {{ width: 90px; font-family: monospace; color: #8f98a0; white-space: nowrap; font-size: 0.8rem; }}
    tr.hist-low td.low-ever {{ color: #ffd24a; font-weight: 700; }}
    td.score {{ width: 65px; font-family: monospace; color: #66c0f4; white-space: nowrap; }}
    /* baixa histórica = AMARELO */
    tr.hist-low {{ background: #332b14 !important; border-left: 3px solid #ffce4a; }}
    tr.hist-low:hover {{ background: #403418 !important; }}
    /* novidade (entrou em promoção hoje) = VERDE — vence o amarelo se ambos */
    tr.new-row {{ background: #14331c !important; border-left: 3px solid #4fd06a; }}
    tr.new-row:hover {{ background: #1a4024 !important; }}
    tr.new-row.hist-low {{ border-left: 3px solid #4fd06a; }}
    .low-badge, .new-badge {{
      display: inline-block;
      margin-left: 7px;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.68rem;
      font-weight: 700;
      vertical-align: middle;
      letter-spacing: 0.03em;
    }}
    .low-badge {{ background: #ffce4a; color: #1a1400; }}
    .new-badge {{ background: #4fd06a; color: #04210b; }}
    .legend {{
      display: flex; flex-wrap: wrap; gap: 18px;
      margin: 0 0 18px; padding: 10px 14px;
      background: #16202d; border: 1px solid #2a3f57; border-radius: 8px;
      font-size: 0.82rem; color: #c7d5e0;
    }}
    .legend .sw {{ display: inline-block; width: 13px; height: 13px; border-radius: 3px; margin-right: 6px; vertical-align: -2px; }}
    .legend .sw.new {{ background: #4fd06a; }}
    .legend .sw.hist {{ background: #ffce4a; }}
    footer {{
      margin-top: 30px;
      color: #8f98a0;
      font-size: 0.78rem;
    }}
  </style>
</head>
<body>
  <h1>Game Promo Ranker</h1>
  <div class="subtitle">Gerado em {now}  —  {total_collected} jogos coletados</div>
  <div class="formula">
    score 0–10 = qualidade(Wilson das reviews) × fama(log reviews) × bônus de desconto
  </div>
  <div class="legend">
    <span><span class="sw new"></span> <b>NEW</b> — entrou em promoção hoje (vs. ontem)</span>
    <span><span class="sw hist"></span> <b>Baixa histórica</b> — menor preço de sempre</span>
  </div>
  {rows_by_block}
  <footer>
    Fórmula: qualidade × fama × bônus de desconto.<br>
    O desconto pesa 50% do seu valor real para não suplantar qualidade e popularidade.
  </footer>
</body>
</html>"""


def save_html(html: str, path: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n[✓] HTML salvo em: {path}")

# ─── Output JSON (consumido pela app Flask) ───────────────────────────────────

# Campos de cada jogo expostos no JSON (mesma ordem/nomes do dict interno).
JSON_GAME_FIELDS = [
    "appid", "name", "discount", "orig_price", "sale_price",
    "pct_positive", "total_reviews", "score", "block",
    "historical_low", "low_price_brl", "is_new", "img_url", "url",
    # enriquecidos (v2): capa larga, gênero/tags, Steam Deck, multi-loja, histórico
    "header_img", "genres", "tags", "deck", "stores", "price_history",
]


def build_json_payload(by_block: dict[str, list[dict]], total_collected: int) -> dict:
    """
    Monta o payload JSON consumido pelo frontend.

    Estrutura:
      {
        "generated_at": "2026-06-29T14:30:00",        # ISO 8601 (local)
        "generated_at_human": "29/06/2026 14:30",
        "total_collected": 512,
        "block_order": [...],                          # ordem canônica dos blocos
        "block_colors": {block: "#hex"},               # cores p/ headers/legenda
        "blocks": [
          {"name": "Very Positive", "color": "#66c0f4", "count": 30, "games": [ {<campos>}... ]},
          ...
        ]
      }

    Jogos de cada bloco já vêm ordenados por score desc (feito em main()).
    """
    now = datetime.now()
    blocks = []
    for block_name in BLOCK_ORDER:
        games = by_block.get(block_name, [])
        if not games:
            continue
        serialized = []
        for g in games:
            row = {k: g.get(k) for k in JSON_GAME_FIELDS}
            # normaliza tipos pra JSON limpo
            row["discount"]      = int(g.get("discount") or 0)
            row["pct_positive"]  = int(g.get("pct_positive") or 0)
            row["total_reviews"] = int(g.get("total_reviews") or 0)
            row["score"]         = round(float(g.get("score") or 0.0), 4)
            row["historical_low"] = bool(g.get("historical_low", False))
            row["is_new"]         = bool(g.get("is_new", False))
            row["low_price_brl"]  = g.get("low_price_brl") or ""
            row["low_src"]        = g.get("low_src") or ""   # "cs"=CheapShark · "obs"=menor observado
            row["reviews_human"]  = fmt_num(int(g.get("total_reviews") or 0))
            # enriquecidos: garante defaults limpos (listas/strings) p/ o frontend
            row["header_img"]     = g.get("header_img") or ""
            row["genres"]         = g.get("genres") or []
            row["tags"]           = g.get("tags") or []
            row["deck"]           = g.get("deck") or ""
            row["stores"]         = g.get("stores") or []
            row["price_history"]  = g.get("price_history") or []
            serialized.append(row)
        blocks.append({
            "name":  block_name,
            "color": BLOCK_HEX.get(block_name, "#888"),
            "count": len(serialized),
            "games": serialized,
        })

    return {
        "generated_at":       now.isoformat(timespec="seconds"),
        "generated_at_human": now.strftime("%d/%m/%Y %H:%M"),
        "total_collected":    total_collected,
        "block_order":        BLOCK_ORDER,
        "block_colors":       BLOCK_HEX,
        "blocks":             blocks,
    }


def save_json(by_block: dict[str, list[dict]], total_collected: int, path: str):
    """Escreve o payload JSON em `path` (cria o diretório-pai se preciso)."""
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    payload = build_json_payload(by_block, total_collected)
    # escreve atomicamente: grava em .tmp e renomeia (evita o Flask ler arquivo parcial)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    print(f"\n[✓] JSON salvo em: {path}")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args       = sys.argv[1:]
    max_pages  = 10
    output_html = "--html" in args
    out_path = "steam_sale_ranker.html"
    if "--out" in args:
        _i = args.index("--out")
        if _i + 1 < len(args):
            out_path = args[_i + 1]

    # --json <PATH>: escreve a lista de jogos (agrupada por block) como JSON.
    # É o que a app Flask serve; o cron passa a usar este modo.
    json_path = None
    if "--json" in args:
        _i = args.index("--json")
        if _i + 1 < len(args):
            json_path = args[_i + 1]
        else:
            print("[!] --json requer um caminho: --json data/games.json")
            sys.exit(1)

    # estado de NEW: guarda os appids ao lado do output principal (JSON tem prioridade)
    _state_anchor = json_path or out_path
    state_path = os.path.join(os.path.dirname(_state_anchor) or ".", "_prev_appids.json")
    hist_cache_path = os.path.join(os.path.dirname(_state_anchor) or ".", HIST_CACHE_NAME)
    meta_cache_path = os.path.join(os.path.dirname(_state_anchor) or ".", META_CACHE_NAME)
    price_series_path = os.path.join(os.path.dirname(_state_anchor) or ".", PRICE_SERIES_NAME)

    numeric = [a for a in args if a.isdigit()]
    if numeric:
        max_pages = max(1, int(numeric[0]))

    print(f"\n{BOLD}Game Promo Ranker{RESET}")
    print(f"Buscando até {max_pages * COUNT_PER_PAGE} jogos em promoção...\n")

    all_games = collect_all(max_pages)

    if not all_games:
        print("\n[!] Nenhum jogo encontrado. Verifique conexão ou tente com VPN.")
        return

    # Deduplicar por appid
    seen: set[str] = set()
    unique: list[dict] = []
    for g in all_games:
        if g["appid"] not in seen:
            seen.add(g["appid"])
            unique.append(g)

    # NEW: jogos que NÃO estavam na geração anterior (ontem) = novidade de hoje.
    prev_appids: set = set()
    try:
        with open(state_path, encoding="utf-8") as _f:
            prev_appids = set(json.load(_f))
    except Exception:
        prev_appids = set()
    for g in unique:
        g["is_new"] = bool(prev_appids) and g["appid"] not in prev_appids

    # Agrupar e ordenar por score
    by_block: dict[str, list[dict]] = defaultdict(list)
    for g in unique:
        by_block[g["block"]].append(g)
    for k in by_block:
        by_block[k].sort(key=lambda x: x["score"], reverse=True)

    # FASE 1 — aplica o que JÁ está em cache (sem rede) e publica imediatamente:
    # baixas históricas, metadados (gênero/tags/Deck) e histórico de preço.
    apply_low_cache(unique, hist_cache_path)
    apply_meta_cache(unique, meta_cache_path)
    apply_price_history(unique, price_series_path)
    if output_html:
        save_html(generate_html(by_block, len(unique)), out_path)
        print(f"\n[fase 1] lista publicada em {out_path}")
    if json_path:
        save_json(by_block, len(unique), json_path)
        print(f"[fase 1] JSON publicado em {json_path} (com as baixas do cache)")

    # FASE 2 — semeia os jogos ainda não cacheados (CheapShark + appdetails, lentos
    # e resumíveis), reaplica os caches e republica com tudo enriquecido.
    seed_low_cache(unique, hist_cache_path)
    apply_low_cache(unique, hist_cache_path)
    seed_meta_cache(unique, meta_cache_path)
    apply_meta_cache(unique, meta_cache_path)
    record_price_history(unique, price_series_path)

    print_results(by_block, len(unique))

    if output_html:
        save_html(generate_html(by_block, len(unique)), out_path)
        print(f"\n[fase 2] baixas históricas (amarelo) marcadas em {out_path}")
    if json_path:
        save_json(by_block, len(unique), json_path)
        print(f"[fase 2] baixas históricas marcadas no JSON {json_path}")

    # salva os appids de hoje para a comparação de NEW na próxima geração
    try:
        with open(state_path, "w", encoding="utf-8") as _f:
            json.dump([g["appid"] for g in unique], _f)
    except Exception:
        pass


if __name__ == "__main__":
    main()
