#!/usr/bin/env python3
"""
Free Games tracker — Epic Games + PlayStation Plus
==================================================
Busca os jogos GRÁTIS da Epic (endpoint público oficial `freeGamesPromotions`,
sem API key, preço/locale BR) E os Monthly Games do PS Plus (RSS oficial do
PlayStation.Blog), gerando um JSON com {current, upcoming, history}.

  - current  : grátis AGORA (Epic: promo ativa zerou o preço · PSN: dentro da
               janela mensal de disponibilidade)
  - upcoming : anunciados como grátis EM BREVE (Epic + próximo mês do PS Plus)
  - history  : append-only — cada jogo que ficou grátis é logado UMA vez
               (com `first_seen`), pra trackear o que já passou.

Cada entrada tem `platform` ("epic"/"psn") — o frontend já mostra o selo certo.
PSN é best-effort: se a fonte falhar, a Epic continua funcionando normalmente.

Uso:
  python free_games.py --json data/free_games.json
"""
import argparse
import calendar
import html
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import requests

EPIC_URL = ("https://store-site-backend-static.ak.epicgames.com/"
            "freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/124.0"}
STORE_BASE = "https://store.epicgames.com/p/"
FREE_GAMES_PAGE = "https://store.epicgames.com/pt-BR/free-games"


def _img(el: dict) -> str:
    imgs = {k.get("type"): k.get("url")
            for k in (el.get("keyImages") or []) if k.get("url")}
    for t in ("OfferImageWide", "DieselStoreFrontWide", "featuredMedia",
              "Thumbnail", "OfferImageTall", "VaultClosed"):
        if imgs.get(t):
            return imgs[t]
    return next(iter(imgs.values()), "")


def _slug(el: dict) -> str:
    for m in (el.get("catalogNs", {}) or {}).get("mappings", []) or []:
        if m.get("pageSlug"):
            return m["pageSlug"]
    for m in el.get("offerMappings", []) or []:
        if m.get("pageSlug"):
            return m["pageSlug"]
    ps = el.get("productSlug") or ""
    return ps.split("/")[0] if ps else ""


def _store_url(el: dict) -> str:
    s = _slug(el)
    return STORE_BASE + s if s else FREE_GAMES_PAGE


def _entry(el: dict, offer: dict, platform: str = "epic") -> dict:
    tp = (el.get("price") or {}).get("totalPrice") or {}
    fmt = tp.get("fmtPrice") or {}
    return {
        "platform":   platform,
        "title":      el.get("title") or "—",
        "cover":      _img(el),
        "url":        _store_url(el),
        "seller":     (el.get("seller") or {}).get("name") or "",
        "orig_price": fmt.get("originalPrice") or "",
        "free_from":  (offer or {}).get("startDate") or "",
        "free_until": (offer or {}).get("endDate") or "",
    }


def fetch_epic():
    r = requests.get(EPIC_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()
    els = ((((r.json().get("data") or {}).get("Catalog") or {})
            .get("searchStore") or {}).get("elements") or [])
    current, upcoming = [], []
    for el in els:
        promos = el.get("promotions") or {}
        cur = promos.get("promotionalOffers") or []
        nxt = promos.get("upcomingPromotionalOffers") or []
        tp = (el.get("price") or {}).get("totalPrice") or {}
        if cur:
            offer = (cur[0].get("promotionalOffers") or [{}])[0]
            if tp.get("discountPrice") == 0:        # ficou de fato grátis
                current.append(_entry(el, offer))
        elif nxt:
            offer = (nxt[0].get("promotionalOffers") or [{}])[0]
            ds = offer.get("discountSetting") or {}
            if ds.get("discountPercentage") == 0:   # só upcoming que zera o preço
                upcoming.append(_entry(el, offer))
    return current, upcoming


def _key(item: dict) -> str:
    return f"{item['platform']}|{item['title']}|{item.get('free_from', '')}"


# ─── PSN — PlayStation Plus Monthly Games ─────────────────────────────────────
# Fonte: RSS oficial do PlayStation.Blog (categoria PS Plus). O post mensal
# "PlayStation Plus Monthly Games for <Mês>: …" lista os jogos no título e, no
# corpo, traz um heading "<Nome> | PS5[, PS4]" + capa por jogo. Usamos o título
# como filtro (descarta headings de cross-promo) e a imagem anterior como capa.
PSN_FEED = "https://blog.playstation.com/category/ps-plus/feed/"
PSN_NS   = {"content": "http://purl.org/rss/1.0/modules/content/"}
_MONTHS  = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}


def _first_tuesday(y: int, m: int) -> datetime:
    """Primeira terça do mês — data em que o PS Plus troca os jogos mensais."""
    for d in range(1, 8):
        if datetime(y, m, d).weekday() == 1:        # 0=seg … 1=ter
            return datetime(y, m, d, tzinfo=timezone.utc)
    return datetime(y, m, 1, tzinfo=timezone.utc)


def _next_month(y: int, m: int) -> tuple:
    return (y + 1, 1) if m == 12 else (y, m + 1)


def _psn_entry(name, cover, url, free_from, free_until) -> dict:
    return {
        "platform":   "psn",
        "title":      name,
        "cover":      cover,
        "url":        url,
        "seller":     "PlayStation Plus",
        "orig_price": "",
        "free_from":  free_from,
        "free_until": free_until,
    }


def _parse_psn_item(title, body, link, pubdate, now):
    """
    Extrai (state, [entries]) de um post 'Monthly Games for <Mês>'.
    state ∈ {current, upcoming, expired} pela janela [1ª terça do mês,
    1ª terça do mês seguinte). Nomes vêm dos headings; o título do post filtra
    headings extras. Devolve (None, []) se o post não casar.
    """
    mt = re.search(r"Monthly Games for\s+([A-Za-z]+)", title)
    month = _MONTHS.get(mt.group(1).lower()) if mt else None
    if not month:
        return None, []
    pm        = re.search(r"\b([A-Za-z]+)\s+(\d{4})\b", pubdate or "")
    pub_month = (_MONTHS.get(pm.group(1).lower()) if pm else None) or now.month
    pub_year  = int(pm.group(2)) if pm else now.year
    year      = pub_year + (1 if month < pub_month else 0)

    start = _first_tuesday(year, month)
    end   = _first_tuesday(*_next_month(year, month))
    state = "current" if start <= now < end else ("upcoming" if now < start else "expired")

    blob  = title.split(":", 1)[1] if ":" in title else title
    blob  = re.sub(r"\s+", " ", html.unescape(blob)).lower()
    heads = [(m.start(), html.unescape(m.group(1)).strip())
             for m in re.finditer(r"<h[1-4][^>]*>([^<|]+?)\s*\|\s*PS[45][^<]*</h[1-4]>", body or "")]
    # \ssrc= (com espaço) evita casar data-src= de imagens lazy/modal ocultas,
    # cujas URLs apontam p/ assets inexistentes (404). Pega só o <img> exibido.
    imgs  = [(m.start(), m.group(1))
             for m in re.finditer(r'<img[^>]*?\ssrc="([^"]+)"', body or "")]

    free_from, free_until = start.isoformat(), end.isoformat()
    entries, seen = [], set()
    for pos, name in heads:
        if re.sub(r"\s+", " ", name).lower() not in blob or name in seen:
            continue                                 # heading fora do título do mês / repetido
        seen.add(name)
        cover = ""
        for ip, iu in imgs:                          # capa = última imagem antes do heading
            if ip < pos:
                cover = iu
            else:
                break
        entries.append(_psn_entry(name, cover, link, free_from, free_until))
    return state, entries


def fetch_psn(now):
    """
    Monthly Games do PS Plus via RSS oficial. Retorna (current, upcoming) no
    MESMO formato da Epic. Best-effort: qualquer falha devolve ([], []).
    """
    try:
        r = requests.get(PSN_FEED, headers=HEADERS, timeout=20)
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception as e:                            # nunca derruba a Epic
        print(f"[aviso] PSN indisponivel: {e}", file=sys.stderr)
        return [], []

    current, upcoming, posts = [], [], 0
    for it in root.iter("item"):
        title = html.unescape(it.findtext("title") or "")
        if "Monthly Games for" not in title:
            continue
        posts += 1
        enc   = it.find("content:encoded", PSN_NS)
        state, entries = _parse_psn_item(
            title, (enc.text if enc is not None else ""),
            it.findtext("link") or "", it.findtext("pubDate") or "", now)
        if state == "current":
            current.extend(entries)
        elif state == "upcoming":
            upcoming.extend(entries)
        if posts >= 3:                                # mês atual + próximo já bastam
            break
    return current, upcoming


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="data/free_games.json")
    args = ap.parse_args()

    now_dt = datetime.now(timezone.utc)
    now    = now_dt.isoformat()
    try:
        current, upcoming = fetch_epic()
    except Exception as e:                          # não destrói o JSON existente
        print(f"[erro] falha ao buscar Epic: {e}", file=sys.stderr)
        sys.exit(1)

    # PSN (PS Plus mensal) — best-effort; falha aqui não derruba a Epic.
    psn_current, psn_upcoming = fetch_psn(now_dt)
    current  = current  + psn_current
    upcoming = upcoming + psn_upcoming

    # histórico append-only (carrega o anterior)
    history, seen = [], set()
    if os.path.exists(args.json):
        try:
            prev = json.load(open(args.json, encoding="utf-8"))
            history = prev.get("history") or []
            seen = {_key(h) for h in history}
        except Exception:
            pass

    added = 0
    for item in current:
        k = _key(item)
        if k not in seen:
            seen.add(k)
            history.append({**item, "first_seen": now})
            added += 1

    history.sort(key=lambda h: h.get("first_seen", ""), reverse=True)
    history = history[:500]

    payload = {
        "generated_at":       now,
        "generated_at_human": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "current":            current,
        "upcoming":           upcoming,
        "history":            history,
    }

    path = args.json
    out_dir = os.path.dirname(path) or "."
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    npsn = sum(1 for c in current if c.get("platform") == "psn")
    print(f"[ok] {len(current)} gratis agora ({npsn} PSN), {len(upcoming)} em breve, "
          f"+{added} no historico ({len(history)} total) -> {path}")


if __name__ == "__main__":
    main()
