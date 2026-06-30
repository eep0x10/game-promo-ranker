#!/usr/bin/env python3
"""
Epic Games Store — Promoções
============================
Lista jogos EM DESCONTO na Epic (GraphQL público da loja, locale/preço BR) e
gera um JSON consumido pela aba "Promoções Epic" do frontend.

Mesmo espírito da aba Steam, MAS a Epic não expõe % de reviews — então não há
score Wilson nem blocos de sentimento. Ordenamos por desconto e, principalmente,
marcamos os jogos que estão **mais baratos que na Steam** (cruzando os títulos
com o data/games.json gerado pelo steam_sale_ranker).

  python epic_deals.py --json data/epic_games.json
"""
import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone

import requests

EPIC_GQL   = "https://store.epicgames.com/graphql"
STORE_BASE = "https://store.epicgames.com/p/"
HEADERS    = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/124.0",
    "Content-Type": "application/json",
}

# Corta shovelware (asset flips de R$ ~20 com "desconto" perpétuo de 95%).
MIN_ORIG_BRL = 25.0
MIN_DISCOUNT = 20

SEARCH_QUERY = """
query searchStoreQuery($category:String,$count:Int,$country:String!,$locale:String,$onSale:Boolean,$sortBy:String,$sortDir:String,$start:Int){
  Catalog{
    searchStore(category:$category,count:$count,country:$country,locale:$locale,onSale:$onSale,sortBy:$sortBy,sortDir:$sortDir,start:$start){
      paging{count total}
      elements{
        title
        seller{name}
        keyImages{type url}
        productSlug
        catalogNs{mappings{pageSlug}}
        offerMappings{pageSlug}
        price(country:$country){ totalPrice{discountPrice originalPrice currencyCode fmtPrice(locale:$locale){discountPrice originalPrice}} }
      }
    }
  }
}
"""


def _img(el: dict) -> str:
    imgs = {k.get("type"): k.get("url")
            for k in (el.get("keyImages") or []) if k.get("url")}
    for t in ("OfferImageWide", "DieselStoreFrontWide", "featuredMedia",
              "Thumbnail", "OfferImageTall", "ProductLogo"):
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


# Edições/sufixos que não fazem parte do "núcleo" do título (p/ casar com a Steam).
_EDITION_RE = re.compile(
    r"\b(complete|deluxe|ultimate|gold|goty|game of the year|definitive|enhanced|"
    r"standard|edition|bundle|collection|remastered|anniversary|director'?s cut|"
    r"premium|digital)\b", re.IGNORECASE)


def _norm_title(title: str) -> str:
    """Normaliza p/ casar títulos entre lojas: sem acento, sem pontuação, sem edição."""
    s = (title or "").replace("™", "").replace("®", "").replace("©", "")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = _EDITION_RE.sub(" ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _parse_brl(price_str: str) -> float:
    try:
        s = re.sub(r"[R$\s]", "", price_str or "")
        s = s.replace(".", "").replace(",", ".")
        return float(s)
    except Exception:
        return 0.0


def fetch_epic_deals():
    """Pagina o searchStore (onSale) e devolve a lista crua de jogos em desconto."""
    games, start, total = [], 0, 1
    while start < total and start < 1000:
        variables = {
            "category": "games/edition/base", "count": 40, "country": "BR",
            "locale": "pt-BR", "onSale": True, "sortBy": "currentPrice",
            "sortDir": "ASC", "start": start,
        }
        r = requests.post(EPIC_GQL, headers=HEADERS,
                          json={"query": SEARCH_QUERY, "variables": variables}, timeout=25)
        r.raise_for_status()
        j = r.json()
        if j.get("errors"):
            print(f"[erro] Epic GraphQL: {json.dumps(j['errors'])[:200]}", file=sys.stderr)
            break
        ss = (((j.get("data") or {}).get("Catalog") or {}).get("searchStore") or {})
        total = (ss.get("paging") or {}).get("total") or 0
        els = ss.get("elements") or []
        if not els:
            break
        games.extend(els)
        start += 40
    return games


def build_entries(raw):
    """Converte elementos crus em entries limpas, filtrando shovelware."""
    out, seen = [], set()
    for el in raw:
        tp  = (el.get("price") or {}).get("totalPrice") or {}
        fmt = tp.get("fmtPrice") or {}
        disc_cents = tp.get("discountPrice")
        orig_cents = tp.get("originalPrice")
        if not isinstance(disc_cents, int) or not isinstance(orig_cents, int):
            continue
        if disc_cents <= 0:            # 100% off = grátis → vai na aba Grátis, não aqui
            continue
        if orig_cents <= 0:
            continue
        sale_brl = disc_cents / 100.0
        orig_brl = orig_cents / 100.0
        discount = round(100 * (orig_brl - sale_brl) / orig_brl)
        if orig_brl < MIN_ORIG_BRL or discount < MIN_DISCOUNT:
            continue
        slug = _slug(el)
        title = el.get("title") or "—"
        key = (title, slug)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "title":      title,
            "norm":       _norm_title(title),
            "seller":     (el.get("seller") or {}).get("name") or "",
            "cover":      _img(el),
            "url":        STORE_BASE + slug if slug else "https://store.epicgames.com/pt-BR/sale",
            "orig_price": fmt.get("originalPrice") or "",
            "sale_price": fmt.get("discountPrice") or "",
            "sale_brl":   round(sale_brl, 2),
            "discount":   discount,
        })
    return out


def load_steam_index(games_json_path):
    """{titulo_normalizado: {price_brl, name, url}} a partir do games.json da Steam."""
    idx = {}
    try:
        d = json.load(open(games_json_path, encoding="utf-8"))
    except Exception:
        return idx
    for b in d.get("blocks", []):
        for g in b.get("games", []):
            price = _parse_brl(g.get("sale_price", ""))
            if price <= 0:
                continue
            key = _norm_title(g.get("name", ""))
            if key and (key not in idx or price < idx[key]["price_brl"]):
                idx[key] = {"price_brl": price, "name": g.get("name", ""),
                            "url": g.get("url", "")}
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="data/epic_games.json")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    try:
        raw = fetch_epic_deals()
    except Exception as e:
        print(f"[erro] falha ao buscar Epic: {e}", file=sys.stderr)
        sys.exit(1)
    games = build_entries(raw)

    # Comparação cross-store: Steam games.json fica no mesmo diretório de saída.
    steam_idx = load_steam_index(
        os.path.join(os.path.dirname(args.json) or ".", "games.json"))
    cheaper = 0
    for g in games:
        s = steam_idx.get(g["norm"])
        g["on_steam"] = bool(s)
        g["cheaper_than_steam"] = False
        if s:
            g["steam_price"] = (f"R$ {s['price_brl']:,.2f}"
                                .replace(",", "X").replace(".", ",").replace("X", "."))
            g["steam_url"] = s["url"]
            if g["sale_brl"] > 0 and g["sale_brl"] < s["price_brl"] - 0.01:
                g["cheaper_than_steam"] = True
                g["steam_save_pct"] = round(100 * (s["price_brl"] - g["sale_brl"]) / s["price_brl"])
                cheaper += 1
        g.pop("norm", None)            # campo interno, não vai pro JSON

    # Ordena: mais-barato-que-Steam → também na Steam (jogo "real") → maior desconto → menor preço.
    games.sort(key=lambda g: (not g["cheaper_than_steam"], not g["on_steam"],
                              -g["discount"], g["sale_brl"]))

    payload = {
        "generated_at":       now.isoformat(timespec="seconds"),
        "generated_at_human": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "total":              len(games),
        "cheaper_than_steam": cheaper,
        "games":              games,
    }

    path = args.json
    out_dir = os.path.dirname(path) or "."
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    print(f"[ok] {len(games)} promocoes Epic ({cheaper} mais baratas que na Steam) -> {path}")


if __name__ == "__main__":
    main()
