# gofrommunich

Delay predictions for Deutsche Bahn trains as a probability spread: for example, 58% on time, 17% 3–5 min, 11% 6–10 min, … and 3% cancelled. It also estimates the risk of missing each connection. Munich is the first city; other cities are added through config.

## How it works

```
HF parquet (monthly) ──backfill──┐
DB Timetables API ──live poller──┼──► Postgres ──► nightly: stats → baseline backtest → LightGBM → promote
                                 │                                                          │
                                 └───────────────── Fastify API ◄── active model (ONNX) ────┘
```

- **Data:** the historical data comes from [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data), 2024-07 onwards, read remotely with DuckDB. Live changes come from the DB Timetables API.
  - For every in-scope train that stops at a hub, *all* its stops are imported. That way arrival predictions work for destinations outside the city too.
- **Target:** the delay bucket of each arrival/departure: `≤2 | 3–5 | 6–10 | 11–15 | 16–30 | 31–60 | >60 | cancelled`.
- **Baseline model:** a pure-Node model using Dirichlet smoothing over empirical counts. It backs off from train+station+time-of-day to train type to global, and more recent data carries more weight.
- **LightGBM model:** stacked on top of the baseline, using calendar and route features.
  - Node computes every feature (`packages/model/src/features.ts`) and exports CSVs. Python (`ml/train.py`) only trains and exports ONNX, which Node serves with `onnxruntime-node`. Training and serving therefore can't drift apart.
  - A new model is promoted only if its validation RPS beats the baseline, and the active model, on held-out recent data.

## Layout

| Path | What |
|---|---|
| `packages/core` | buckets, connection-risk maths, time zones, trip keys, city configs (`src/cities/`) |
| `packages/db` | SQL migrations, migrate/seed, the shared stop-event merge (COPY → staging → upsert) |
| `packages/iris` | Timetables API client (rate limited, retries), XML parser |
| `packages/model` | stats, baseline, features, training export, ONNX serving, backtests, registry |
| `apps/worker` | CLI: backfill, poller, nightly jobs, training |
| `apps/api` | `/predict`, `/resolve-share`, `/stations`, `/trains/:type/:number`, `/health` |
| `ml/` | LightGBM trainer (Python) |

## Local setup

Requirements: Node 22+ and Docker Desktop.

```sh
cp .env.example .env          # add DB_CLIENT_ID / DB_API_KEY for the live poller
docker compose up -d db       # Postgres on localhost:5433
npm install
npm run migrate               # schema + station seed
npm run worker -- backfill    # all published months (~25 min); or --from 2026-06 --to 2026-08
npm run worker -- refresh-stats
npm run api                   # http://localhost:8080
```

Training locally without Python:

```sh
docker build -t gfm-trainer ml
TRAINER=docker npm run worker -- train
```

Other worker commands are `poll` (live poller), `nightly`, `backtest --days 28`, `import-latest` and `run` (poller + scheduler, used in production).

Tests: `npm test`. DB integration tests use `TEST_DATABASE_URL`, which is reset on each run.

## API

```sh
curl -X POST localhost:8080/predict -H 'content-type: application/json' -d '{
  "legs": [{ "trainType": "ICE", "trainNumber": "618", "fromEva": "8000261", "toEva": "8000284",
             "plannedDep": "2026-09-28T13:01:00Z", "plannedArr": "2026-09-28T14:05:00Z" }]}'
```

The response contains:
- per-stop bucket probabilities and "P(≥ X min)";
- for each transfer, the probability that the connection fails, split into delay vs. cancellation;
- live status when the poller has seen the train;
- the model version.

`POST /resolve-share { text, url, title }` accepts the payload of a DB Navigator "Reise teilen" share. It works out the legs and returns a prediction.
- It parses the share's train blocks: `ICE 514` followed by `From 15:28 München Hbf, Platform 13` and `To 17:43 Stuttgart Hbf, …`, plus German `Von/Nach` lines.
- Dates can be US, EU or ISO format.
- The real iOS share is a test fixture in `apps/api/test/fixtures/`.
- Resolving the `vbid` link via bahn.de is opt-in (`ENABLE_VBID_LOOKUP=1`). That endpoint's bot protection blocks non-browser clients, so it isn't relied on.

## Deployment (Oracle Cloud Ampere, arm64)

```sh
docker compose --profile app up -d --build
docker compose exec worker npx tsx apps/worker/src/cli.ts backfill
```

`worker` runs migrations, the live poller and the nightly scheduler:
- 02:30: finalise live data, refresh stats, backtest, train and promote;
- 3rd of each month: import new dataset months.

`api` picks up newly promoted models within 5 minutes.

## Adding a city

1. Add `packages/core/src/cities/<city>.ts` with hub/corridor EVAs and train types, and register it in `cityConfig.ts`.
2. Run `npm run migrate` to tag the stations, then `npm run worker -- backfill --city <id>`.
3. Run a worker (and API) with `CITY=<id>`.

## Data & licence

The delay data is © Deutsche Bahn AG, licensed CC BY 4.0:
- the historical data via [piebro/deutsche-bahn-data](https://github.com/piebro/deutsche-bahn-data) (Brömmel, *Deutsche Bahn Data*);
- the live data via the [DB API Marketplace](https://developers.deutschebahn.com) Timetables API.

API responses include this attribution.

## Model status (2026-09-28, data up to 2026-08-31)

All figures are on the held-out last 4 weeks.

| | RPS ↓ | log loss ↓ | Brier P(≥6 min) ↓ |
|---|---|---|---|
| Climatology (one global distribution) | 0.1318 | 1.443 | 0.207 |
| **Baseline (active)** | **0.1093** | 1.362 | 0.174 |
| LightGBM (stacked, weekly chunks) | 0.1094 | **1.332** | 0.174 |

- The baseline is well calibrated: for example, it predicts 52.3% on time against 52.3% observed.
- LightGBM improves log loss but not RPS, so the promotion gate keeps the baseline active.
- The next real gains should come from signals the baseline can't see:
  - nowcast features from the live poller (the train's current delay, the station's delays over the last hours);
  - weather;
  - planned construction work.

Lessons from getting here:
- Early stopping must hold out a whole time chunk.
- `month` and `minute_of_day` let the model memorise the training period.
- Chunks of 28 days left the features too stale and caused a level shift; weekly chunks fixed it.

## Known limitations / open items

- The dataset stores the last snapshot from a poll every 6 hours, not confirmed actual times. Before 2025-11 it only covers about 100 major stations, so destinations outside that set have no data for 2024-07 to 2025-10.
- IRIS only reports changes. A live stop with no change is labelled "on time" only if the poller was demonstrably running at that station (see `finaliseLiveEvents`).
- Only the English iOS share format has been captured so far. German-language and Android shares should be added as fixtures.
- iOS Safari has no Web Share Target support, so the future web app will need a native share extension or a paste flow on iOS.
