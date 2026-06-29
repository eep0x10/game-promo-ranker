#!/usr/bin/env python3
"""
Steam Sale Ranker — backend Flask
=================================
Serve o frontend estático e expõe 2 endpoints JSON:

  GET /api/games
      Devolve o JSON gerado 1x/dia pelo cron (steam_sale_ranker.py --json).
      Lê de DATA_FILE (default: data/games.json). Inclui a data de geração.

  GET /api/steam-user?profile=<vanity-ou-url>
      Resolve o perfil Steam informado (URL .../id/<vanity> ou .../profiles/<id>,
      ou só o vanity), e busca SERVER-SIDE, sem API key, usando só endpoints
      públicos:
        - wishlist : store.steampowered.com/wishlist/.../wishlistdata/?p=N
        - owned    : steamcommunity.com/.../games?tab=all&xml=1  (XML)
      Devolve {"ok":true,"wishlist":[appids],"owned":[appids]} ou
      {"ok":false,"error":"..."} em caso de perfil privado / inexistente.

Tudo é same-origin (front + API no mesmo host) → sem CORS.
"""

import os
import re
import xml.etree.ElementTree as ET

import requests
from flask import Flask, jsonify, request, send_from_directory

# ─── Config ───────────────────────────────────────────────────────────────────

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR  = os.path.join(BASE_DIR, "static")
# Caminho do JSON gerado pelo cron. Override via env DATA_FILE.
DATA_FILE   = os.environ.get(
    "DATA_FILE", os.path.join(BASE_DIR, "data", "games.json")
)
HTTP_TIMEOUT = 10  # segundos — todos os fetches externos

# Headers de browser (a Steam bloqueia/limita user-agents "robôs").
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) "
        "Gecko/20100101 Firefox/124.0"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "application/json, text/javascript, text/xml, */*; q=0.01",
}

app = Flask(__name__, static_folder=None)

# ─── Frontend estático ────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/favicon.svg")
def favicon():
    # favicon.svg vive na raiz do projeto (mantido junto do gerador)
    return send_from_directory(BASE_DIR, "favicon.svg", mimetype="image/svg+xml")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)

# ─── /api/games ───────────────────────────────────────────────────────────────

@app.route("/api/games")
def api_games():
    """Devolve o JSON gerado pelo cron. 503 se ainda não houver dados."""
    if not os.path.exists(DATA_FILE):
        return jsonify({
            "ok": False,
            "error": "dados ainda nao gerados — rode o cron (steam_sale_ranker.py --json)",
            "blocks": [],
        }), 503
    # send_from_directory aplica caching/etag/last-modified de graça.
    directory = os.path.dirname(DATA_FILE) or "."
    filename  = os.path.basename(DATA_FILE)
    return send_from_directory(directory, filename, mimetype="application/json")

# ─── /api/steam-user ──────────────────────────────────────────────────────────

# Aceita: URL completa, ".../id/<vanity>", ".../profiles/<steamid64>", ou só o vanity.
_RE_ID       = re.compile(r"steamcommunity\.com/id/([^/?#]+)", re.IGNORECASE)
_RE_PROFILES = re.compile(r"steamcommunity\.com/profiles/(\d+)", re.IGNORECASE)
_RE_STEAMID  = re.compile(r"^\d{17}$")
_RE_APIKEY   = re.compile(r"^[0-9A-Fa-f]{32}$")


def _parse_profile(raw: str):
    """
    Normaliza a entrada do usuário em (kind, value):
      kind == 'id'        → vanity URL  (.../id/<value>)
      kind == 'profiles'  → steamid64   (.../profiles/<value>)
    Retorna (None, None) se não der pra extrair nada.
    """
    s = (raw or "").strip()
    if not s:
        return None, None

    m = _RE_PROFILES.search(s)
    if m:
        return "profiles", m.group(1)

    m = _RE_ID.search(s)
    if m:
        return "id", m.group(1)

    # Sem URL: se forem 17 dígitos é um steamid64, senão tratamos como vanity.
    bare = s.rstrip("/").split("/")[-1]
    if _RE_STEAMID.match(bare):
        return "profiles", bare
    # remove um eventual "@" colado por engano e espaços
    bare = bare.lstrip("@").strip()
    if bare:
        return "id", bare
    return None, None


def _resolve_steamid64(kind: str, value: str):
    """
    Devolve (steamid64:str|None, erro:str|None).
      - kind=='profiles' → value já é o steamID64.
      - kind=='id'       → resolve o vanity via id/<vanity>/?xml=1 → <steamID64>.
    Os endpoints atuais da Steam (wishlist/owned) exigem o steamID64 numérico;
    o XML do perfil é o único caminho público p/ resolver um vanity sem API key.
    """
    if kind == "profiles":
        return value, None
    try:
        r = requests.get(
            f"https://steamcommunity.com/id/{value}/",
            params={"xml": 1}, headers=BROWSER_HEADERS, timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        return None, "falha de rede ao resolver o perfil"
    if r.status_code != 200:
        return None, "perfil nao encontrado"
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError:
        return None, "perfil nao encontrado"
    # <response><error>The specified profile could not be found.</error></response>
    err = root.find("error")
    if err is not None and (err.text or "").strip():
        return None, "perfil nao encontrado (confira o nome/URL)"
    sid = root.find("steamID64")
    if sid is not None and (sid.text or "").strip().isdigit():
        return sid.text.strip(), None
    return None, "nao foi possivel resolver o steamID64 do perfil"


def _fetch_wishlist(steamid64: str):
    """
    Wishlist pública via IWishlistService/GetWishlist/v1 (SEM API key — endpoint
    atual; o antigo store.../wishlistdata foi descontinuado pela Steam em 2024).
    Retorna (appids:list[int]|None, erro:str|None). None = privada/indisponível.
    """
    try:
        r = requests.get(
            "https://api.steampowered.com/IWishlistService/GetWishlist/v1/",
            params={"steamid": steamid64},
            headers=BROWSER_HEADERS, timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        return None, "falha de rede ao buscar a wishlist"
    if r.status_code != 200:
        return None, "wishlist privada (deixe a lista de desejos publica na Steam)"
    try:
        data = r.json()
    except ValueError:
        return None, "resposta invalida da wishlist"
    items = (data.get("response") or {}).get("items")
    if items is None:
        # response == {} → wishlist privada (ou inexistente)
        return None, "wishlist privada (deixe a lista de desejos publica na Steam)"
    appids: list[int] = []
    for it in items:
        ap = it.get("appid")
        if isinstance(ap, int):
            appids.append(ap)
        elif str(ap).isdigit():
            appids.append(int(ap))
    return appids, None


def _fetch_owned(steamid64: str, api_key: str):
    """
    Biblioteca via IPlayerService/GetOwnedGames — REQUER API key. A Steam fechou
    o acesso anônimo à biblioteca em 2024 (games?xml=1 redireciona p/ /login), e
    GetOwnedGames sem key responde 401. Sem key → aviso não-fatal (não erro).
    Retorna (appids:list[int]|None, aviso/erro:str|None).
    """
    if not api_key:
        return None, ("remover jogos que voce ja tem precisa de uma API key "
                      "opcional — a Steam fechou o acesso anonimo a biblioteca")
    try:
        r = requests.get(
            "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
            params={
                "key": api_key, "steamid": steamid64,
                "include_appinfo": 0, "include_played_free_games": 1,
                "format": "json",
            },
            headers=BROWSER_HEADERS, timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException:
        return None, "falha de rede ao buscar a biblioteca"
    if r.status_code in (401, 403):
        return None, "API key invalida (a comparacao de wishlist segue funcionando)"
    if r.status_code != 200:
        return None, "biblioteca indisponivel no momento"
    try:
        data = r.json()
    except ValueError:
        return None, "resposta invalida da biblioteca"
    games = (data.get("response") or {}).get("games")
    if games is None:
        return None, "detalhes de jogo privados (deixe 'Detalhes do jogo: Publico')"
    appids: list[int] = []
    for g in games:
        ap = g.get("appid")
        if isinstance(ap, int):
            appids.append(ap)
        elif str(ap).isdigit():
            appids.append(int(ap))
    return appids, None


@app.route("/api/steam-user")
def api_steam_user():
    profile_raw = request.args.get("profile", "")
    api_key = (request.args.get("key", "") or "").strip()
    if api_key and not _RE_APIKEY.match(api_key):
        api_key = ""  # key malformada → ignora e segue só com a wishlist

    kind, value = _parse_profile(profile_raw)
    if not kind:
        return jsonify({
            "ok": False,
            "error": "informe seu perfil, ex.: https://steamcommunity.com/id/seu_perfil",
        })

    # Endpoints atuais exigem o steamID64; resolvemos o vanity primeiro.
    steamid64, sid_err = _resolve_steamid64(kind, value)
    if not steamid64:
        return jsonify({"ok": False, "error": sid_err or "perfil nao encontrado"})

    # Wishlist é o recurso principal (sem key); owned é opcional (precisa key).
    wishlist, w_err = _fetch_wishlist(steamid64)
    owned,    o_err = _fetch_owned(steamid64, api_key)

    if wishlist is None:
        return jsonify({"ok": False, "error": w_err or "wishlist privada ou nao encontrada"})

    return jsonify({
        "ok": True,
        "profile": {"steamid64": steamid64},
        "wishlist": sorted(set(wishlist or [])),
        "owned":    sorted(set(owned or [])),
        # aviso não-fatal quando a biblioteca não veio (sem key / privada)
        "warnings": [o_err] if (owned is None and o_err) else [],
    })

# ─── Healthcheck ──────────────────────────────────────────────────────────────

@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "data_present": os.path.exists(DATA_FILE)})


if __name__ == "__main__":
    # Dev server. Em produção usa-se gunicorn (ver Dockerfile).
    app.run(host="0.0.0.0", port=8000, debug=True)
