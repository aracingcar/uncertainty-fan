# Hydroclimate Uncertainty Fan

Initial local implementation of [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md). Includes a reproducible **synthetic** 360-chain release (3 scenarios × 3 GCMs × 2 downscaling × 2 bias correction × 5 hydro parameter sets × 2 members), Zarr cube, Parquet products, FastAPI/DuckDB API, Arrow stream, and a browser dashboard: the range (fan with slicers), sources of spread, a screening threshold and Climate Futures context. See [docs/REMEDIATION_GUIDE.md](docs/REMEDIATION_GUIDE.md) for the changes made after external review and [docs/decisions.md](docs/decisions.md) for the decisions behind them.

## Run

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/python -m hydrofan.build
.venv/bin/uvicorn hydrofan.api:create_app --factory --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. Tests: `.venv/bin/pytest`.

The build command creates `data/demo-<content-hash>/` and updates `data/current.json` only after structural checks pass. The API pins one release on startup; restart it to adopt a new build. Set `HYDROFAN_DATA` for a different product root. API documentation: `/docs`.

## Implemented

- Per-chain baseline validation and normalisation; six response estimators (`poly2/3/4/6`, `lowess`, `member_mean`); balanced main effects, explicit interaction, complete-design rejection.
- Variance split with member-to-member response differences kept as slow internal variability, residuals as fast internal variability, an **independent** total and an explicit `unattributed` term; the build fails if the mean unattributed share exceeds 5%.
- One selectable timescale (10-year mean by default, or single year) for the fan, shares, cascade and headline.
- Two metrics: percentage change against each chain's own baseline, and absolute values.
- Variance shares shown with their range across estimators; GCM-bootstrap intervals (500 draws) in the product store and headline tooltip.
- Four breach rules (annual, at least N dry years per decade, at least N consecutive dry years, decadal mean) with correct denominators, scored on annual values for the percentage metric. `persistent` is a deprecated alias.
- GET catalogues, variance, quantiles, cascade, sensitivity, bootstrap, exceedance, futures and an Arrow IPC cube. Build identity in payloads, Arrow metadata and headers. Parameterised SQL, no write endpoints.
- Dashboard: fan first with filters beside it and removable chips; scope badges on every panel; a fan key; the selected horizon marked on the fan and breach table; accessible chart names and descriptions; data tables with CSV download; filtered chain CSV export.
- Tests: Python (analytics, estimator truth tests, API, static export, copy guard) and JavaScript (`npm test`: stats, breach-rule parity fixture, static reader).

## Deliberate first-slice limits

This is a development scaffold, **not a validated catchment projection**. No climate inputs, observed gauge records, calibrated Source model, or authoritative thresholds were supplied. Demo outputs must not be used for planning. The baseline uses calendar years; real water-year aggregation must happen before production ingestion.

The client is buildless JavaScript/SVG for this first slice, rather than React/D3. It loads the cube once using the API's JSON compatibility option; the binary Arrow endpoint is ready for a future Arrow JS client. Only one node is available, with two runoff metrics. Slicers calculate empirical envelopes and breaches; the cascade and variance shares remain explicitly labelled as unsliced. Scenario selection constrains grid rows, with other scenarios marked n=0.

Historical skill, calibration acceptance, QUALYPSO, forcing ingestion/bias correction, Source/Veneer integration, and resumable orchestration are pending. Demo release QA records these as pending, never passed. The demo build is allowed despite those pending scientific gates; a production release must enforce them. The empirical-versus-normal-approximation width check is a flag, not evidence of scientific validity. Variance shares are shown with their range across six response estimators, and the product store carries GCM-bootstrap intervals (500 draws over three GCMs, so wide); these are sensitivity checks, not credible intervals. Precomputed quantile slices currently include `all` only; arbitrary combinations use the local chunk.

Before real-data work, settle the guide's Phase 0 decisions: authoritative climate products, catchment/metric definitions, water-year convention, calibrated parameters, regulatory versus exploratory thresholds, and the internal-variability method. Retain equal GCM weighting or implement explicit hierarchical weights before accepting unbalanced data.

## GitHub Pages

The repository includes `.github/workflows/pages.yml`. On pushes to `main`, Actions runs the Python and JavaScript tests, rebuilds the synthetic products, and exports `_site/`. For public repositories it also deploys with GitHub Pages. Private repositories run validation without publishing. Pull requests run the build and tests without deploying.

Pages hosts only the static synthetic demonstration. The Python API remains available for local development. Both modes use the same dashboard and product response shapes; the static client reads one exported JSON bundle and slices locally. Assets and catalogue links are relative so project subpaths work.

To export or preview the Pages version locally:

```sh
.venv/bin/python -m hydrofan.build
.venv/bin/python -m hydrofan.export_static --output _site
.venv/bin/python -m http.server 8080 --directory _site --bind 127.0.0.1
```

Open http://127.0.0.1:8080. JavaScript adapter tests: `npm test` (no npm dependencies to install). The exporter requires `synthetic: true`; this publication path is intentionally limited to demo data.
