#!/usr/bin/env python3
"""
Xbox Game Pass (PC) — catálogo + chegaram/saíram
================================================
Lista o catálogo atual do PC Game Pass (API pública catalog.gamepass.com +
DisplayCatalog da Microsoft, mercado BR) e detecta, por DIFF entre execuções,
os jogos que CHEGARAM e os que SAÍRAM recentemente (janela de 14 dias).

Não há fonte pública estável para "coming soon" (jogos anunciados antes de
chegar), então usamos o snapshot do próprio catálogo: assim que um jogo aparece
ele entra em "chegaram"; quando some, entra em "saíram". Auto-mantido.

  python gamepass.py --json data/gamepass.json
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta

import requests

SIGL_PC_ALL = "fdd9e2a7-0fee-49f6-ad69-4354098401ff"   # "All PC Games"
SIGLS_URL   = "https://catalog.gamepass.com/sigls/v2"
DCAT_URL    = "https://displaycatalog.mp.microsoft.com/v7.0/products"
MARKET, LANG = "BR", "pt-BR"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/124.0"}
WINDOW_DAYS = 14
RECENT_CAP  = 60


def fetch_sigl_ids(sigl):
    r = requests.get(SIGLS_URL, headers=HEADERS, timeout=25,
                     params={"id": sigl, "language": LANG.lower(), "market": MARKET})
    r.raise_for_status()
    return [x["id"] for x in r.json() if isinstance(x, dict) and x.get("id")]


def _img(p):
    lp = (p.get("LocalizedProperties") or [{}])[0]
    imgs = {i.get("ImagePurpose"): i.get("Uri")
            for i in (lp.get("Images") or []) if i.get("Uri")}
    for t in ("BoxArt", "Poster", "FeaturePromotionalSquareArt", "BrandedKeyArt",
              "TitledHeroArt", "SuperHeroArt", "Screenshot", "Logo"):
        u = imgs.get(t)
        if u:
            return ("https:" + u) if u.startswith("//") else u
    return ""


def resolve(ids):
    """Resolve product IDs → detalhes via DisplayCatalog (em lotes de 20)."""
    out = {}
    for i in range(0, len(ids), 20):
        batch = ids[i:i + 20]
        try:
            r = requests.get(DCAT_URL, headers=HEADERS, timeout=25, params={
                "bigIds": ",".join(batch), "market": MARKET,
                "languages": LANG, "MS-CV": "DGU1mcuYo0WMMp.1",
            })
            prods = r.json().get("Products", [])
        except Exception:
            continue
        for p in prods:
            pid = p.get("ProductId")
            if not pid:
                continue
            lp = (p.get("LocalizedProperties") or [{}])[0]
            out[pid] = {
                "id":    pid,
                "title": lp.get("ProductTitle") or "—",
                "dev":   lp.get("DeveloperName") or lp.get("PublisherName") or "",
                "cover": _img(p),
                "url":   f"https://www.microsoft.com/store/productId/{pid}",
            }
    return out


def _load_snap(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
            return d.get("catalog") or {}, d.get("removed") or []
    except Exception:
        return {}, []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="data/gamepass.json")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    try:
        ids = fetch_sigl_ids(SIGL_PC_ALL)
        details = resolve(ids)
    except Exception as e:
        print(f"[erro] falha ao buscar Game Pass: {e}", file=sys.stderr)
        sys.exit(1)

    catalog = [details[i] for i in ids if i in details]   # preserva a ordem do SIGL
    if not catalog:
        print("[erro] catálogo vazio — nada gravado", file=sys.stderr)
        sys.exit(1)
    cur_ids = {g["id"] for g in catalog}

    out_dir   = os.path.dirname(args.json) or "."
    snap_path = os.path.join(out_dir, "gamepass_prev.json")
    prev_cat, removed_hist = _load_snap(snap_path)
    had_prev = bool(prev_cat)

    # first_seen: herda do snapshot, senão é agora.
    new_snap = {}
    for g in catalog:
        first_seen = (prev_cat.get(g["id"], {}) or {}).get("first_seen") or now_iso
        new_snap[g["id"]] = {**g, "first_seen": first_seen}

    # saíram agora = estavam no snapshot e não estão mais no catálogo.
    just_removed = [{**v, "removed_at": now_iso}
                    for k, v in prev_cat.items() if k not in cur_ids]
    seen_removed = {r["id"] for r in just_removed}
    # histórico de removidos (sem duplicar; re-removidos atualizam a data).
    for r in removed_hist:
        if r.get("id") not in seen_removed and r.get("id") not in cur_ids:
            just_removed.append(r)
            seen_removed.add(r.get("id"))

    cutoff = (now - timedelta(days=WINDOW_DAYS)).isoformat()
    # chegaram = first_seen dentro da janela (só quando já havia baseline).
    added = sorted(
        [g for g in new_snap.values() if had_prev and g["first_seen"] >= cutoff],
        key=lambda g: g["first_seen"], reverse=True)[:RECENT_CAP]
    removed = sorted(
        [r for r in just_removed if r.get("removed_at", "") >= cutoff],
        key=lambda r: r.get("removed_at", ""), reverse=True)[:RECENT_CAP]

    catalog_sorted = sorted(catalog, key=lambda g: g["title"].lower())

    payload = {
        "generated_at":       now_iso,
        "generated_at_human": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "total":              len(catalog_sorted),
        "added":              [{k: v for k, v in g.items() if k != "first_seen"} for g in added],
        "removed":            [{k: v for k, v in r.items() if k != "first_seen"} for r in removed],
        "catalog":            catalog_sorted,
    }

    # grava saída + snapshot (atômico).
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, args.json)

    snap = {"catalog": new_snap, "removed": just_removed[:RECENT_CAP * 3],
            "updated": now_iso}
    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(snap, fh, ensure_ascii=False)
    os.replace(tmp, snap_path)

    print(f"[ok] Game Pass PC: {len(catalog_sorted)} no catalogo, "
          f"+{len(added)} chegaram, -{len(removed)} sairam (14d) -> {args.json}")


if __name__ == "__main__":
    main()
