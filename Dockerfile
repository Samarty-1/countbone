# countbone server: API, dashboard, counting worker. One process, one volume.
#
#   docker build -t countbone .
#   docker run -p 8000:8000 -v countbone:/data countbone
#
# The dashboard is prebuilt into the package (src/countbone/api/static), so no
# Node is needed here. Everything the deployment owns lives under /data:
# the database, the keys, run artifacts, uploads, evidence packs and catalog
# photos. Back up /data and nothing else.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install ".[api]" && useradd --create-home --uid 10001 countbone && mkdir /data && chown countbone /data

USER countbone
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

# 0.0.0.0 inside the container; put it behind the Caddy service (TLS) in
# docker-compose.yml rather than exposing port 8000 to the internet.
CMD ["countbone", "serve", "--host", "0.0.0.0", "--port", "8000", \
     "--db", "/data/countbone.db", "--out", "/data/runs", "--data-dir", "/data/countbone-data"]
