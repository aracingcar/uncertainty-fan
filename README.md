# Hydroclimate Uncertainty Fan

Initial local implementation of [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md). Includes a reproducible **synthetic** 360-chain release (3 scenarios × 3 GCMs × 2 downscaling × 2 bias correction × 5 hydro parameter sets × 2 members), Zarr cube, Parquet products, FastAPI/DuckDB API, Arrow stream, and browser dashboard views A–D.

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

- Positive per-chain baseline validation and delta normalisation; centred polynomial response fit, pooled residual IV, balanced main effects, explicit interaction, complete-design rejection.
- Scenario-specific and explicitly pooled products; deterministic chain provenance; quantile, cascade, preset breach and illustrative Climate Futures tables.
- GET catalogues, variance, quantiles, cascade, exceedance, futures, and Arrow IPC cube. Build identity in response payloads/Arrow metadata and headers. Parameterised SQL and no write endpoints.
- All four views, local multi-factor filtering, grey full-envelope comparison, three threshold rules with correct denominators, consistent source colours, mismatch flags, chain catalogue and filtered CSV export.
- Closure, monotonic quantile, baseline, missing-design, breach-rule, and API/Arrow tests.

## Deliberate first-slice limits

This is a development scaffold, **not a validated catchment projection**. No climate inputs, observed gauge records, calibrated Source model, or authoritative thresholds were supplied. Demo outputs must not be used for planning. The baseline uses calendar years; real water-year aggregation must happen before production ingestion.

The client is buildless JavaScript/SVG for this first slice, rather than React/D3. It loads the cube once using the API's JSON compatibility option; the binary Arrow endpoint is ready for a future Arrow JS client. Only one node and one metric are available. Slicers calculate empirical envelopes and breaches; the cascade and variance shares remain explicitly labelled as unsliced. Scenario selection constrains grid rows, with other scenarios marked n=0.

Historical skill, calibration acceptance, GCM bootstrap intervals, QUALYPSO, forcing ingestion/bias correction, Source/Veneer integration, and resumable orchestration are pending. Demo release QA records these as pending, never passed. The demo build is allowed despite those pending scientific gates; a production release must enforce them. Range agreement is reported as a flag, not evidence of scientific validity. No credible intervals are shown. Precomputed quantile slices currently include `all` only; arbitrary combinations use the local chunk.

Before real-data work, settle the guide's Phase 0 decisions: authoritative climate products, catchment/metric definitions, water-year convention, calibrated parameters, regulatory versus exploratory thresholds, and the internal-variability method. Retain equal GCM weighting or implement explicit hierarchical weights before accepting unbalanced data.

## GitHub Pages

The repository includes `.github/workflows/pages.yml`. On pushes to `main`, Actions runs the Python and JavaScript tests, rebuilds the synthetic products, exports `_site/`, and deploys it with GitHub Pages. Pull requests run the build and tests without deploying.

Pages hosts only the static synthetic demonstration. The Python API remains available for local development. Both modes use the same dashboard and product response shapes; the static client reads one exported JSON bundle and slices locally. Assets and catalogue links are relative so project subpaths work.

To export or preview the Pages version locally:

```sh
.venv/bin/python -m hydrofan.build
.venv/bin/python -m hydrofan.export_static --output _site
.venv/bin/python -m http.server 8080 --directory _site --bind 127.0.0.1
```

Open http://127.0.0.1:8080. JavaScript adapter tests: `npm test` (no npm dependencies to install). The exporter requires `synthetic: true`; this publication path is intentionally limited to demo data.
