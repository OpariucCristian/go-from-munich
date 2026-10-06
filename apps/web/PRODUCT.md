# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** hiring managers and engineers judging the author's ML and full-stack skills. They skim the live app first, then go deeper into How it works and Accuracy to see whether the method and its results hold up.
- **Riders using it for real:** people on RE, IC/EC and ICE trains through Munich who want to know how late their train will be and whether they'll make their connection. The showcase only works if the app is genuinely useful to them.

## Product Purpose

Spät forecasts Deutsche Bahn delays as a probability spread over delay buckets (`≤2 | 3–5 | 6–10 | 11–15 | 16–30 | 31–60 | >60 min | cancelled`) instead of one number. It also estimates the risk of missing each connection. The app is a working tool and a portfolio piece at once: it succeeds when a rider gets a forecast they can act on and a technical reviewer comes away convinced that the modelling, evaluation and engineering are sound.

## Positioning

What DB Navigator doesn't offer:

- **Forecasts before any live data:** useful hours or days ahead, not only once the train is already running late.
- **A probability spread:** a full distribution rather than a single live delay figure.
- **Connection-miss risk:** the chance of missing each transfer, computed from the forecast distributions.
- **An honest track record:** forecasts are frozen, scored against what actually happened, and published (calibration, ranked probability score, the "80% chance it's at most X min late" limit). Uncertainty is stated openly.

## Operating Context

- Riders check on a phone, often shortly before or during a trip. The app is a PWA with an Android share target, so a train shared from another app (`/share`) opens its forecast.
- Reviewers usually arrive on a desktop browser from a link and look across Estimate, Departures, Patterns, Accuracy and How it works.
- Screens: start screen (search by train, route or station, plus a live overview), Estimate, Departures, Patterns, Accuracy, How it works.

## Capabilities and Constraints

- **Scope:** RE, IC, EC and ICE trains at München Hbf, München Ost and München-Pasing. For in-scope trains, every stop is imported, so arrival forecasts also cover destinations outside Munich. Munich only: Hamburg was dropped on 2026-10-06. City support remains config-driven.
- **Data:** historical data from piebro/deutsche-bahn-data (Hugging Face) from 2024-07 onwards, plus live data from the DB Timetables API. Live signals: nowcast, upstream stations and weather.
- **Models:** a Dirichlet-smoothed baseline, with a LightGBM model stacked on top. A new model is promoted only if it beats both the baseline and the active model on held-out data. The UI shows model version, data freshness and live status.
- **Architecture:** the web app talks only to the NestJS BFF (`/bff/*`), whose view-model contract lives in `apps/bff/src/contract.ts`. It is hosted on an Always Free Oracle ARM VM, so it must stay lightweight and cost nothing.
- **Language:** English for now, with copy kept i18n-ready for a later German version. German station names stay in German.
- **Terminology:** "on time" means ≤2 min. The range metric is one-sided ("80% chance it's at most X min late", p80). Any illustrative numbers in explanations are labelled as made up.

## Brand Commitments

- Name: **Spät**.
- Required attribution: "Delay data © Deutsche Bahn AG (CC BY 4.0)" and "Forecasts are estimates, not guarantees."
- No DB branding or implied affiliation.

## Evidence on Hand

- Real live forecasts, departures and patterns served from production data.
- A real accuracy history: daily scoring of frozen first predictions, seeded by an honest 28-day replay that is marked as replay.
- Backtest and validation RPS figures from the model registry.
- **Absent, never fabricate:** user counts, testimonials, press, endorsements, or any affiliation with Deutsche Bahn.

## Product Principles

1. **Useful first, impressive as a result.** Every screen has to serve a real rider. The craft shows by doing that well, not by being decorated.
2. **Show the uncertainty.** Present distributions and risk honestly, and never collapse them into false precision.
3. **Earn trust with receipts.** Make the method and the scored track record easy to inspect, including where the model falls short.
4. **Legible to experts and riders alike.** A rider grasps the answer at a glance, and an engineer can drill down to how it was computed.
