<div align="center">

# 🎮 Steam Sale Ranker

**Encontra as melhores promoções da Steam por qualidade real — não só pelo tamanho do desconto.**

Um ranker que combina avaliação dos jogadores, popularidade e desconto num **score de 0 a 10**,
compara com a **sua wishlist** e ainda rastreia os **jogos grátis da Epic**.

[**▶ Demo ao vivo**](https://gamepromo.eep0x10.tech) · feito em Python + Flask, atualizado 1×/dia

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-gunicorn-000000?logo=flask&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![Sem API key](https://img.shields.io/badge/wishlist-sem%20API%20key-4fd06a)

</div>

---

## ✨ O que faz

- 🏆 **Ranking por qualidade real** — score 0–10 que pondera *quão boas são as reviews*, *quantas são* e *quanto está de desconto*. Um jogo nota 9 com 500 mil reviews vale mais que um "95%" com 60 reviews.
- 🎨 **Interface em cards ou tabela** — alterne entre uma **grade visual** (capa, gauge de score colorido, sparkline de preço) e a **tabela densa** pra quem quer varrer tudo. A escolha fica salva no navegador.
- 🌗 **Tema claro/escuro** — botão no topo, também persistido localmente.
- 📊 **Hero com stats ao vivo** — total rankeado, quantos estão na baixa histórica, favoritos (e quantos deles em baixa!) e o melhor score do dia.
- 💰 **"Esse preço é bom mesmo?"** — cada jogo ganha um selo (**MENOR PREÇO / ÓTIMO / BOM / OK**) e o **% acima da baixa histórica**, então dá pra ver na hora se vale comprar agora ou esperar.
- ⭐ **Favoritos (sem login)** — favorite jogos (salvos no navegador) e filtre só por eles; o app avisa quando um favorito bate a **baixa histórica**.
- 🎮 **Steam Deck + gênero** — badge de compatibilidade com o Deck (Verificado/Jogável/Não suportado) e **filtro por gênero**.
- 🏬 **Comparação multi-loja** — quando **GOG, Fanatical, Epic** (etc.) estão mais baratos que a Steam, aparece a **melhor loja** com o % de economia (via CheapShark).
- 🎯 **Mostra só a nata** — por padrão exibe os jogos **score 7–10**; o resto fica num *"Ver mais"* ao fim de cada bloco de avaliação.
- 🔎 **Filtros e busca** — por nome, gênero, desconto mínimo, avaliação mínima, e ordenação (score, maior desconto, **mais perto da baixa**, mais reviews, melhor avaliação, menor preço).
- 🏷️ **Legenda clicável** — clique em **Favoritos**, **NEW**, **Baixa histórica** ou **Wishlist** pra filtrar só aqueles jogos.
- ❤️ **Compara com a sua wishlist** — cole o link do seu perfil Steam e os jogos da sua lista de desejos em promoção ficam grifados. **Sem precisar de API key.**
- 🟡 **Baixa histórica** — destaca os jogos no **menor preço de todos os tempos** (via CheapShark).
- 🟢 **NEW** — destaca o que **entrou em promoção hoje** (compara com a geração de ontem).
- 🎁 **Aba de jogos grátis** — os *gratuitos pra resgatar e ficar* da **Epic Games Store**, com "grátis agora", "em breve" e **histórico** do que já passou.

---

## 🧮 Como o score funciona

```
score (0–10) = 10 × qualidade × (0.75 + 0.25·fama) × (0.80 + 0.20·desconto)
```

| Fator | O que é | Por quê |
|---|---|---|
| **qualidade** | Limite inferior de **Wilson 95%** da proporção de reviews positivas | Junta *% positivas* **e** *nº de reviews* num número só, com confiança estatística. 95% de 200 reviews vale **menos** que 95% de 200 mil — resolve o hype de baixa amostragem. É o **núcleo** do score. |
| **fama** | `log10(reviews)` saturando perto de 100k | Popularidade conta, mas como **modificador suave** (×0.75–1.0): não domina nem zera um bom jogo. |
| **desconto** | `% de desconto` | Outro modificador suave (×0.80–1.0): bom negócio sobe, mas qualidade vem primeiro. |

**Calibração** (exemplos reais da fórmula):

| Jogo | Reviews | Desconto | Score |
|---|---:|---:|---:|
| Joia AAA · 97% positivas · 500k reviews | 500 000 | 70% | **9.1** |
| Nicho excelente · 95% · 800 reviews | 800 | 75% | **7.9** |
| Muito positivo · 88% · 20k reviews | 20 000 | 50% | **7.6** |
| Hype · 95% mas **só 60 reviews** | 60 | 80% | **7.0** ⬅ confiança puxa pra baixo |
| Mediano · 70% · 2k reviews | 2 000 | 80% | **6.0** |
| Fraco · 50% · 200 reviews | 200 | 90% | **3.7** |

Os jogos são agrupados pelos **blocos oficiais de avaliação da Steam**:

| Bloco | Critério |
|---|---|
| Overwhelmingly Positive | ≥ 95% com 500+ reviews |
| Very Positive | 80–94% com 500+ reviews |
| Mostly Positive | 70–79% |
| Mixed | 40–69% |
| Mostly Negative | 20–39% |
| Overwhelmingly Negative | < 20% com 500+ reviews |

> Só entram jogos com **≥ 2.000 reviews** e **≥ 15% de desconto** (ignora obscuros e promoções irrelevantes).

---

## ❤️ Comparação com o perfil Steam

Cole a URL do seu perfil (`steamcommunity.com/id/...`, `/profiles/...` ou só o nome) e a app:

- **Wishlist** → busca via `IWishlistService/GetWishlist/v1` (endpoint público, **sem API key**) e grifa em azul os seus desejados que estão em promoção.
- **Jogos que você já tem** *(opcional)* → como a Steam fechou o acesso anônimo à biblioteca em 2024, remover os que você já possui precisa de uma **API key opcional** (`IPlayerService/GetOwnedGames`). Sem a key, a comparação de wishlist funciona normalmente.

> 🔒 **Privacidade:** nada é armazenado no servidor. O perfil é consultado server-side só naquela requisição (evita CORS) e a API key, se informada, é usada só ali e descartada.

---

## 🎁 Jogos grátis (Epic)

Lê o feed público `freeGamesPromotions` da Epic (sem API key, preço/locale BR) e separa:

- **Grátis agora** — só os realmente *100% off* (descarta as promos pagas que a Epic mistura no mesmo feed).
- **Em breve** — os já anunciados pra próxima rotação.
- **Histórico** — log **append-only** de tudo que já ficou grátis (com data de quando apareceu).

> PSN e Prime ficam de fora: não há fonte pública estável (os alvos bloqueiam bots e os títulos do PS Plus exigem assinatura).

---

## 🏗️ Arquitetura

```mermaid
flowchart LR
    subgraph cron["Cron diário"]
        G1["steam_sale_ranker.py --json<br/>(Steam Search + CheapShark)"]
        G2["free_games.py --json<br/>(Epic freeGamesPromotions)"]
    end
    G1 -->|games.json| V[("volume<br/>steam_data")]
    G2 -->|free_games.json| V
    V --> A["app.py (Flask + gunicorn)"]
    A -->|"/api/games · /api/free-games<br/>/api/steam-user"| B["static/ (front: tabs, filtros, cards)"]
    B --> U(["🧑 Browser"])
    U -.->|perfil| A
    A -.->|"wishlist / owned"| S["Steam Web API"]
```

O gerador roda em **2 fases**: publica a lista na hora (fase 1) e depois enriquece com baixa histórica via CheapShark (fase 2, mais lenta), republicando. A app Flask só serve os JSONs + o frontend estático e faz o proxy do perfil Steam.

---

## 🚀 Rodando localmente

### CLI (só o gerador, no terminal)

```bash
pip install -r requirements.txt

python steam_sale_ranker.py 12 --json data/games.json   # gera o JSON da lista
python free_games.py --json data/free_games.json         # gera os grátis da Epic
python steam_sale_ranker.py 12                           # tabela colorida no terminal
```

### App completa (Docker)

```bash
# 1) app web (serve front + APIs na porta 8000)
docker build -t steam-sale-app .
docker run -d --name gamepromo -p 8000:8000 -v steam_data:/app/data steam-sale-app

# 2) gerador (imagem única com os dois scripts)
docker build -f Dockerfile.gen -t steam-gen .
docker run --rm -v steam_data:/app/data steam-gen 12 --json data/games.json
docker run --rm --entrypoint python -v steam_data:/app/data steam-gen \
    free_games.py --json data/free_games.json
```

Abra **http://localhost:8000**. (Sem `games.json` ainda, a lista mostra um aviso até o gerador rodar.)

---

## 🌐 Deploy em produção

Pensado pra rodar atrás de um **nginx-proxy** (rede Docker), com a app e o gerador compartilhando o volume `steam_data`:

```yaml
# docker-compose.prod.yml (resumido)
services:
  gamepromo:
    build: .
    environment:
      - VIRTUAL_HOST=gamepromo.seu-dominio
      - VIRTUAL_PORT=8000
    volumes: [steam_data:/app/data]
    networks: [web]
```

Os dados são atualizados por **cron** (uma imagem `steam-gen` serve os dois jobs):

```cron
0 3 * * *  docker run --rm -v steam_data:/app/data steam-gen 12 --json data/games.json
0 4 * * *  docker run --rm --entrypoint python -v steam_data:/app/data steam-gen free_games.py --json data/free_games.json
```

---

## 🔌 Endpoints da API

| Rota | Descrição |
|---|---|
| `GET /` | Frontend (abas Promoções / Grátis) |
| `GET /api/games` | JSON da lista rankeada (gerado pelo cron) |
| `GET /api/free-games` | Jogos grátis: `current` / `upcoming` / `history` |
| `GET /api/steam-user?profile=<url>&key=<opcional>` | Resolve o perfil e devolve `wishlist` + `owned` |
| `GET /healthz` | Healthcheck |

---

## 📦 Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `DATA_FILE` | `data/games.json` | Caminho do JSON da lista |
| `FREE_FILE` | `data/free_games.json` | Caminho do JSON dos grátis |
| `EPIC_FILE` | `data/epic_games.json` | Caminho do JSON das promoções Epic |
| `GAMEPASS_FILE` | `data/gamepass.json` | Caminho do JSON do Game Pass |
| `PORT` (via gunicorn) | `8000` | Porta da app |

Constantes do gerador (em `steam_sale_ranker.py`): `MIN_REVIEWS=2000`, `MIN_DISCOUNT=15`, `COUNT_PER_PAGE=50`, `SEED_BATCH=120` (baixa/loja CheapShark por run), `META_BATCH=80` (gênero/Deck via appdetails por run).

Caches persistentes (no volume `data/`, ao lado do `games.json`): `historical_lows.json` (baixa + multi-loja), `meta_cache.json` (gênero/tags/Deck) e `price_series.json` (histórico de preço, 1 ponto/dia). Todos enchem incrementalmente e são resumíveis — um timeout no meio não perde progresso.

---

## 🙏 Fontes de dados

- **Steam Store Search API** — jogos em promoção e contagem de reviews
- **Steam appdetails** + relatório de compat. do Deck — gênero, tags e Steam Deck
- **CheapShark API** — menor preço histórico **e** preços multi-loja (GOG/Fanatical/Epic…), rate limit respeitado (2 req/s)
- **Steam Web API** (`IWishlistService` / `IPlayerService`) — wishlist e biblioteca
- **Epic Games** (`freeGamesPromotions`) — jogos grátis

Projeto pessoal, sem fins comerciais. Marcas e dados pertencem aos seus respectivos donos.
