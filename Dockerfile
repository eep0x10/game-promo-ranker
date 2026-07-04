# Game Promo Ranker — app Flask (frontend + API)
# Serve a lista de jogos (JSON gerado pelo cron) e a comparação com o perfil Steam.
# O JSON é gerado FORA deste container (cron rodando steam_sale_ranker.py --json),
# normalmente montando data/ como volume. Ver Dockerfile.gen para o gerador.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_FILE=/app/data/games.json

WORKDIR /app

# Dependências primeiro (cache de layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código da app + assets do frontend
COPY app.py favicon.svg ./
COPY static/ ./static/

# Diretório do JSON (montado como volume em produção; o cron escreve aqui)
RUN mkdir -p /app/data

EXPOSE 8000

# 2 workers, 4 threads cada → suficiente p/ I/O-bound (fetch Steam server-side).
# timeout 30s cobre wishlist paginada lenta.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", \
     "--workers", "2", "--threads", "4", "--timeout", "30", \
     "app:app"]
