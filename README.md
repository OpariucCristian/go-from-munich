# gofrommunich

Delay predictions for Deutsche Bahn trains as a probability spread: for example, 58% on time, 17% 3–5 min, 11% 6–10 min, … and 3% cancelled. It also estimates the risk of missing each connection. Munich is the first city; other cities are added through config.

## How it works

```
HF parquet (monthly) ──backfill──┐
DB Timetables API ──live poller──┼──► Postgres ──► nightly: stats → baseline backtest → LightGBM → promote
                                 │                                                          │
                                 └───────────────── Fastify API ◄── active model (ONNX) ────┘
                                                        ▲
                                        NestJS BFF (/bff/*) ◄── React web app "Spät"
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
| `apps/api` | core API: `/predict`, `/predict/stops`, `/resolve-share`, `/departures/:eva`, `/connections`, `/patterns`, `/accuracy`, `/featured`, `/stations`, `/trains/:type/:number`, `/meta`, `/health` |
| `apps/bff` | NestJS backend-for-frontend: turns predictions into screen view models (`src/contract.ts`), serves the built web app |
| `apps/web` | React + Vite web app ("Spät"): estimate, departures, patterns, accuracy; PWA with an Android share target |
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

Web app (three processes: API, BFF, Vite dev server with hot reload):

```sh
npm run api                   # core API on :8080
npm run bff                   # BFF on :3000 (CORE_API_URL, default http://localhost:8080)
npm run web                   # http://localhost:5173, proxies /bff to the BFF
```

`npm run build:web` builds `apps/web/dist`, which the BFF serves at http://localhost:3000 with an SPA fallback. The BFF registers the static files at startup, so restart it after a rebuild.

Training locally without Python:

```sh
docker build -t gfm-trainer ml
TRAINER=docker npm run worker -- train
```

Other worker commands:
- `poll` (live poller plus the accuracy and weather jobs), `run` (poller + scheduler, used in production), `nightly`, `import-latest`;
- `backtest --days 28`, `refresh-nowcast`, `backtest-nowcast [--days 28] [--date YYYY-MM-DD]`;
- `weather-backfill [--from YYYY-MM-DD --to YYYY-MM-DD]`, `weather-forecast`;
- `snapshot`, `score [--date YYYY-MM-DD]`, `replay-accuracy [--days 28]`;
- `register-model --dir models/<version>`.

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

## Web app

The UI follows the "Spät Delay Forecast" design (Claude Design): Schibsted Grotesk and JetBrains Mono, warm paper background, green → amber → red for risk. There is no component library; the components are small hand-built React components on the design tokens in `apps/web/src/styles.css`. Data fetching uses TanStack Query, and all state lives in the URL, so every estimate is a shareable link.

| Screen | What it shows |
|---|---|
| Estimate (`/`) | Opens on an example when nothing was searched: the train leaving the Munich hubs in the next 3 hours with the largest predicted delay (from the hourly saved predictions), counting only trains with at least 30 minutes of journey ahead. Search by route (direct trains between two stations, ranked by the chance of arriving more than 5 minutes late), by train number, or by pasted share text. The forecast shows the most likely delay, the delay it's 80% likely to stay within, the delay distribution (ranges or "within X minutes"), a stop-by-stop timeline, confidence and live status. |
| Shared trip (`/share`) | Landing page for DB Navigator shares. The PWA manifest registers it as a GET `share_target`, so on Android the installed app appears in the share sheet. |
| Departures (`/departures`) | Next 90 minutes at Hbf, Ost or Pasing, with probability bars (on time / 3–10 / >10 min) and live delays. Refreshes every minute. |
| Patterns (`/patterns`) | Average departure delay by weekday × hour at the hubs. |
| Accuracy (`/accuracy`) | How the forecasts held up: green calls that held, how often the "80% chance" limit held, skill against a one-size-fits-all forecast, typical miss in minutes, a daily trend, a calibration plot, breakdowns by train type / station / lead time, and the biggest misses. See [Accuracy tracking](#accuracy-tracking). |

Rules the BFF applies so every screen agrees:
- **Tone:** green below 20%, amber from 20% to 35%, red above 35% chance of being more than 5 minutes late (cancellations count as late).
- **Headline number:** the median delay if the train runs. It is not the mean, which the long tail inflates. The mean appears as "Average, if it runs".
- **Stale times:** when a date has no run in our data yet, stop times come from the same weekday's most recent run, and the page says so.

Left out for now: the design's network map, and the "why this estimate" factor breakdown, because the model has no per-factor attribution yet.

## Accuracy tracking

Offline backtests re-score history. Accuracy tracking instead records what the app actually predicted before each train ran, and checks it against what happened.

1. **Freeze.** Every hour at :05, `snapshot` predicts each in-scope stop at the polled stations (hubs and corridor) that appears in the live plan within the next 13 hours.
   - It uses the active model, the same one the API serves.
   - It stores the prediction in `prediction_snapshots` together with its lead time and model version.
   - Only the *first* prediction per stop is kept, usually about 12 hours ahead.
2. **Score.** Every day at 06:30, `score` does three things:
   - finalises live labels (a watched stop with no change ran on time);
   - scores every finished service day that is still unscored, and rescores the last two days to pick up late labels;
   - writes per-prediction outcomes (observed bucket, RPS, log loss) and one `accuracy_daily` row per day and model version.
   Stops without a label, for example because the poller was down, count as unlabelled; they are never counted as correct or wrong.
3. **Replay.** `replay-accuracy --days 28` seeds history before live tracking started.
   - For each of the last 28 days with data, the baseline statistics are rebuilt from events planned *before* that day, with no look-ahead.
   - Every labelled stop of the day is predicted with those statistics, and the day is scored like a live one.
   - These rows are stored as `source = 'replay'` and the page labels them as replayed.
   - A full run takes about 20 minutes.

`accuracy_daily` stores these metrics:
- RPS, log loss and Brier score for P(>5 min late);
- the RPS of the global (climatology) distribution, which gives the skill score;
- how often the most likely bucket was right;
- how often trains stayed within the predicted 80th percentile ("80% chance it's at most X min late"; target 80%);
- the mean gap between the predicted median and the actual delay;
- predicted vs observed late share;
- 10 calibration bins;
- breakdowns by train type, station group, arrival/departure and lead time.

`GET /accuracy?days=30&source=all|live|replay|near` merges the most recent N scored days. On a date that has both, live wins over replay.

`near` is a second live snapshot per stop, taken 30–90 minutes before it, when a sighting of the train (see [Live signals](#live-signals)) can already shape the prediction. It is scored the same way and shown as "Shortly before" on the Accuracy page. It is never mixed into `all`.

## Live signals

The history tables only know what usually happens. These signals describe today.

**Live-delay nowcast** (`packages/model/src/nowcast.ts`). A *sighting* is the latest stop of the run, planned 5–240 minutes before the target stop and already passed, with a known delay.
- `agg_nowcast_stats` counts, from the last 180 days of full runs, the delay bucket at a stop given the bucket seen at an earlier stop of the same run and the gap between them. It uses three levels: station + train type, train type, and all trains.
- The nightly job rebuilds it: about 1 minute locally, 4.5 minutes on the VM.
- `NowcastLayer` wraps the active model and smooths the matching table into its distribution. Predictions record the sighting they used, and the estimate page says "Based on +12 min at Rosenheim, 47 min earlier".
- A passed live stop with no reported change counts as on time if the poller was watching that station.
- Backtest (`backtest-nowcast`, August 2026, 60k stops at the polled stations), RPS baseline → nowcast:

| Gap | 5–15 min | 15–30 | 30–60 | 60–120 | 120–240 |
|---|---|---|---|---|---|
| Baseline | 0.103 | 0.105 | 0.117 | 0.142 | 0.162 |
| + nowcast | **0.040** | **0.051** | **0.070** | **0.098** | **0.132** |

**Upstream stations.** `CityConfig.upstream` (Salzburg Hbf, Kufstein, Stuttgart Hbf, Würzburg Hbf) is polled like the corridor, keeping only trains that pass a Munich hub. These stations only provide earlier sightings; they are not predicted or scored.

**Delay causes.** IRIS messages on live stops go into `stop_messages`:
- delay causes (type `d`, e.g. code 31 "construction work");
- quality notes (`q`);
- announcements (`h`);
- disruptions (`r`).

The estimate page shows the latest cause next to the live delay (`packages/core/src/reasons.ts`). There is no history of these, so they become model features once several weeks have been collected.

**Weather** (`apps/worker/src/weather.ts`, `packages/model/src/weather.ts`). Hourly data from [Open-Meteo](https://open-meteo.com) (free, no key) for `CityConfig.weatherPoints`, stored in `weather_hourly`:
- `weather-backfill` loads the archive since 2024-06 in a few seconds;
- the forecast refreshes hourly at :15, and archive values replace forecast ones daily at 04:00;
- features cover the city's temperature, 3h rain and snow and gusts, plus the regional worst case.

**LightGBM features v3.** The model inputs include the sighting (`seen_delay_min`, `seen_gap_min`) and the weather:
- Half the training rows get a random "now" 5–240 minutes before the stop, and the sighting found at that moment by `sightingsForRuns`. That is the same lookup serving uses, so historical sightings train the model on the kind of input it will see live.
- A model trained this way uses sightings itself, and the nowcast layer is switched off for it.
- Validation rows also carry `ref_p*`, what is served without LightGBM (baseline + nowcast). A model is only promoted if it beats that.
- Models are trained on a PC and shipped with `scripts/model-deploy.sh <version>`; the VM never trains.

## Deployment (Oracle Cloud Ampere, arm64)

```sh
docker compose --profile app up -d --build
docker compose exec worker npx tsx apps/worker/src/cli.ts backfill
```

`worker` runs migrations, the live poller and the nightly scheduler:
- 02:30: finalise live data, refresh stats and nowcast tables, backtest, train and promote (unless `DISABLE_TRAINING=1`);
- 3rd of each month: import new dataset months;
- hourly at :05: freeze predictions for newly planned stops and for stops 30–90 minutes away;
- hourly at :15: weather forecast; 04:00: weather archive for the last 10 days;
- 06:30: score finished days (see [Accuracy tracking](#accuracy-tracking)).

`api` picks up newly promoted models within 5 minutes. `bff` serves the web app and the `/bff` API on port 3000.

Current server: an Oracle **Always Free** VM.Standard.A1.Flex in eu-frankfurt-1 (1 OCPU, 6 GB RAM, 47 GB boot disk, Ubuntu 24.04 arm64). The app lives in `~/gofrommunich`.

- **Updates:** `DEPLOY_KEY=<key path> DEPLOY_HOST=ubuntu@<ip> scripts/deploy.sh`. It uploads the working tree (never `.env` or keys), rebuilds, and restarts. The server's `.env` and database stay as they are.
- **Server `.env`:** the DB API keys, `CITY`, a random `POSTGRES_PASSWORD` and `DISABLE_TRAINING=1`. With that flag the nightly job still refreshes the baseline and nowcast statistics but skips LightGBM, which is too heavy for 1 OCPU.
- **Models:** train on a PC (`TRAINER=docker npm run worker -- train`, ideally on a fresh `pg_dump` of the server's DB), then run `DEPLOY_KEY=… DEPLOY_HOST=… scripts/model-deploy.sh <version>`. It copies `model.onnx` and `metrics.json` into the `models` volume and runs `register-model`, which promotes the model only if it beats what is currently served.
- **Weather history:** after the first deploy, run `docker compose exec worker npx tsx apps/worker/src/cli.ts weather-backfill` once.
- **Network:** Postgres and the core API listen on localhost only. The Oracle security list only allows SSH. Open the web app through a tunnel, `ssh -i <key> -L 3000:localhost:3000 ubuntu@<ip>`, then http://localhost:3000.
- **One poller only:** don't run a local poller while the server's is running. They share the DB API keys and the 60 calls/minute limit.

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

**Update 2026-09-29, live signals.** On the same validation weeks, half the rows got a sampled live sighting:

| | RPS ↓ | log loss ↓ | Brier ↓ |
|---|---|---|---|
| Baseline | 0.1093 | 1.362 | 0.174 |
| **Baseline + nowcast tables (active)** | **0.1048** | 1.323 | **0.168** |
| LightGBM v3 (sightings + weather, stacked on the above) | 0.1068 | **1.307** | 0.171 |

- LightGBM again wins on log loss but not RPS, so the lookup tables stay in service.
- The model's most-used new inputs are the sighting delay and the temperature.
- Delay-cause messages are the next candidate feature once `stop_messages` has several weeks of data.

Lessons from getting here:
- Early stopping must hold out a whole time chunk.
- `month` and `minute_of_day` let the model memorise the training period.
- Chunks of 28 days left the features too stale and caused a level shift; weekly chunks fixed it.

## Train stop lists

`/trains/:type/:number?date=` builds a train's stops for a date. The data comes from three sources, and each has gaps:
- **The historical dataset** covers German stations only. For a train from Vienna, its first stop in the data is Simbach, or even München Ost.
- **Live stop events** exist only for the stations the poller watches, so a day's own run is usually partial.
- **The live timetable feed** carries each train's full planned route, including stations abroad. The poller stores it in `trips.route` from plan responses.

The stop list is built like this (`apps/api/src/trainRun.ts`):
1. Pick an earlier run that calls at every station seen that day, in the same order, and has at least the usual number of stops. This matters because routes change: ICE 118 skipped München Hbf all summer and serves it from September.
2. Move that run to the date, then align its times to the day's own partial run, since timetables shift.
3. Drop calls the day's route doesn't make. Station names are matched loosely, because the feed writes "Vaihingen(Enz)" where the dataset has "Vaihingen (Enz)".
4. Return the train's real origin and destination, e.g. EC 1216 Wien Hbf → München Hbf. The page shows them.

## Known limitations / open items

- The dataset stores the last snapshot from a poll every 6 hours, not confirmed actual times. Before 2025-11 it only covers about 100 major stations, so destinations outside that set have no data for 2024-07 to 2025-10.
- IRIS only reports changes. A live stop with no change is labelled "on time" only if the poller was demonstrably running at that station (see `finaliseLiveEvents`).
- Only the English iOS share format has been captured so far. German-language and Android shares should be added as fixtures.
- iOS Safari has no Web Share Target support. On iOS, users paste the shared text (the "Shared trip" tab); appearing in the iOS share sheet needs a native app with a Share Extension.
- The September 2026 dataset month is published in early October. Until then, route and pattern views fall back to August runs and live data.
