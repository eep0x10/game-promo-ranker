#!/usr/bin/env python3
"""
Free Games tracker — Epic Games
===============================
Busca os jogos GRÁTIS da Epic (endpoint público oficial `freeGamesPromotions`,
sem API key, preço/locale BR) e gera um JSON com {current, upcoming, history}.

  - current  : grátis AGORA (preço zerado por uma promo ativa)
  - upcoming : anunciados como grátis EM BREVE (a Epic entrega isso)
  - history  : append-only — cada jogo que ficou grátis é logado UMA vez
               (com `first_seen`), pra trackear o que já passou.

PSN/Prime ficam de fora: não há fonte pública estável (alvos bloqueiam bot e os
títulos do PS Plus exigem assinatura). Fácil de estender aqui se aparecer uma.

Uso:
  python free_games.py --json data/free_games.json
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="data/free_games.json")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).isoformat()
    try:
        current, upcoming = fetch_epic()
    except Exception as e:                          # não destrói o JSON existente
        print(f"[erro] falha ao buscar Epic: {e}", file=sys.stderr)
        sys.exit(1)

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
    print(f"[ok] {len(current)} gratis agora, {len(upcoming)} em breve, "
          f"+{added} no historico ({len(history)} total) -> {path}")


if __name__ == "__main__":
    main()
