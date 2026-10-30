# Hydroclimate Uncertainty Fan — Implementation Guide

Oct 30, 2026 · Rory Hackett · Shared doc: https://claude.ai/artifact/DjQmH8wuoZwr6uSbcfs8jc

> **Status.** This is the original design. Where the running code differs, [docs/REMEDIATION_GUIDE.md](docs/REMEDIATION_GUIDE.md) and [docs/decisions.md](docs/decisions.md) record the changes made after external review (member variance, persistence rules, timescale, estimator sensitivity, labels, layout). The sections below were updated to match.

## Purpose and scope

Build a dashboard that shows **how wide** future catchment flow could be, **why** it is that wide, and **how often** it breaches a critical threshold. Everything is pre-computed offline; the dashboard only slices and draws.

The dashboard answers three questions:

1. **Where does the uncertainty come from?** Emissions, GCM, downscaling/bias correction, hydrological model parameters, or internal climate variability — and how that mix changes from the 2030s to the 2090s.
2. **How wide is the plausible range?** A P10–P90 fan of runoff or e-flow achievement, 2020–2100, relative to a 1990–2019 baseline.
3. **How robust is the system?** The share of ensemble runs that breach a supply or ecological threshold, per decade and per SSP.

Out of scope: live model runs, single-run forecasts, and assigning probabilities to SSPs (scenarios are shown side by side, never weighted).

Primary users are water resource planners and catchment modellers; a summary view serves policy and executive readers.

## Architecture

Models run offline once; the dashboard only slices pre-computed results.

```mermaid
flowchart LR
    subgraph Offline["Offline, per release"]
        A["Select GCMs<br/>Climate Futures matrix, 5–10 GCMs"] --> B["Climate forcing<br/>SSP × GCM × DS × BC per subcatchment"]
        B --> C["Hydrological runs<br/>eWater Source via Veneer × param sets"]
        C --> D["Metric cube<br/>metrics.zarr: chains × node × year"]
        D --> E["Analytics engine<br/>ANOVA / QUALYPSO, quantiles, breaches"]
        E --> F["Product store<br/>Parquet tables, versioned build_id"]
    end
    subgraph Online["Online, per request"]
        G["Read-only API<br/>FastAPI + DuckDB, Arrow chunk stream"] --> H["Dashboard<br/>Views A–D, slices in the browser"]
    end
    F --> G
```

Everything in the offline block runs in batch when inputs change (new downscaled release, recalibration); the API and dashboard only read versioned products, so no model ever runs on a user request.

## Experiment design: the modelling cascade

Each **chain** is one path through the cascade: SSP → GCM → downscaling → bias correction → hydrological parameter set → realisation. Variance partitioning only works if the chains form a (near-)crossed matrix, so design the matrix before running anything.

| Factor | Dimension name | Suggested levels | Typical count | Source |
| --- | --- | --- | --- | --- |
| Emissions scenario | `ssp` | SSP1-2.6, SSP2-4.5, SSP3-7.0 | 3 | CMIP6 |
| Global climate model | `gcm` | e.g. ACCESS-CM2, ACCESS-ESM1-5, EC-Earth3, MPI-ESM1-2-HR, NorESM2-MM | 5–10 | CMIP6, selected via Climate Futures |
| Downscaling | `ds` | RCM configurations (NARCliM2.0 WRF, CCAM) or statistical method | 2–3 | NARCliM / CCAM / CORDEX-Australasia |
| Bias correction | `bc` | e.g. QME, QDM, MRNBC | 2 | Applied in-house or supplied |
| Hydrological parameters | `hydro` | Behavioural or posterior parameter sets (GR4J, Sacramento, SIMHYD) | 10–30 | Calibration with DREAM, SCE-UA or GLUE |
| Internal variability | `member` | Initial-condition members or stochastic replicates | 1–5 | GCM members or a stochastic generator |

A 3 × 8 × 2 × 2 × 20 × 1 design is 1,920 chains — cheap for a rainfall-runoff model, expensive for a full Source river model. If full Source runs are too slow, run the parameter dimension on the rainfall-runoff component only and route a reduced set (e.g. 5 parameter sets chosen as quantiles of the full set's mean annual flow).

### Selecting GCMs with Climate Futures

1. For every available CMIP6 GCM, compute the change in annual mean temperature and annual (or cool-season) rainfall for 2060–2079 vs 1990–2019 over the catchment.
2. Classify each GCM into a matrix: temperature (*Warmer*, *Hotter*, *Much hotter*) × rainfall (*Much drier*, *Drier*, *Little change*, *Wetter*). Set class edges from the ensemble spread, e.g. terciles of ΔT and ±5% / ±15% for ΔP.
3. Record the share of GCMs in each cell — this is the consensus likelihood shown in the dashboard ("7 of 12 models: Hotter & Drier").
4. Pick GCMs so every occupied cell has at least one member, and always keep the "most likely", "wettest" and "driest" representatives. Prefer GCMs that are also boundary conditions in the downscaled products you use.
5. Screen out GCMs with poor historical skill over the region (seasonal rainfall cycle, ENSO/IOD teleconnections) before selection, and document why.

### Unbalanced designs

Downscaling products rarely cross every GCM with every RCM. Either (a) partition variance on the largest balanced sub-matrix and report the rest as additional envelope runs, or (b) use a method that handles missing cells (QUALYPSO, or a random-effects model — see Variance partitioning). Record which design each product used.

## Data model and storage

One master **metric cube** holds every chain's annual result; every dashboard product is derived from it. Store the cube as Zarr and the derived products as Parquet.

### Master cube: `metrics.zarr`

```text
dims:   ssp, gcm, ds, bc, hydro, member, node, metric, year
vars:   value    float32   annual metric value (absolute units)
        delta    float32   % change vs the chain's own 1990–2019 mean
        valid    bool      false where a chain does not exist (unbalanced design)
coords: year     1990–2100 (water year, e.g. Jul–Jun)
        node     gauge / storage / e-flow site ids
        metric   annual_runoff, low_flow_q90, storage_min, eflow_success, supply_reliability
chunks: one chunk per (node, metric), all chains and years
```

Size check: 1,920 chains × 111 years × 20 nodes × 5 metrics × 4 bytes ≈ 85 MB per variable. Chunking by (node, metric) means one dashboard request reads one ~0.9 MB chunk.

Use `delta` (per-chain change vs baseline) for the fan and the partitioning. It removes each chain's baseline bias, which is otherwise the largest spurious source of spread between hydrological parameter sets.

### Derived products (Parquet, partitioned by `node` / `metric`)

| Table | Grain | Key columns | Feeds view |
| --- | --- | --- | --- |
| `quantiles` | node × metric × ssp × timescale × year × slice | p05, p10, p25, p50, p75, p90, p95, mean (response), n_chains | B, D |
| `variance` | node × metric × ssp × timescale × year | var_ssp, var_gcm, var_ds, var_bc, var_hydro, var_interaction, var_internal (= var_internal_slow + var_internal_fast), var_unattributed, var_total (independent), member_count | A, B |
| `cascade` | node × metric × ssp × timescale × horizon × stage | stage order, p10, p50, p90 of the cumulative ensemble | A |
| `sensitivity` | node × metric × ssp × timescale × estimator × horizon | share_climate, share_hydro, share_internal, share_interaction | A (headline ranges) |
| `bootstrap` | node × metric × ssp × timescale × horizon | P05 / P50 / P95 of each share over GCM resamples, draws, gcm_count | A (tooltip), QA |
| `exceedance` | node × metric × ssp × decade × rule | breach_share, n_chains, n_breach, denominator (annual values; percentage-change metric only) | C |
| `climate_futures` | gcm × ssp × horizon | dT, dP, class, cell_share | D (context) |
| `chains` | chain id | ssp, gcm, ds, bc, hydro, member, provenance | all (filters) |

`metric` is one of `annual_runoff` (% change against each chain's own baseline) and `annual_runoff_abs` (absolute values, baseline differences kept). `timescale` is `decadal` (centred 10-year running mean; label year *y* is the mean of *y*−5…*y*+4) or `annual`.

`slice` in `quantiles` is a string such as `all`, `gcm=ACCESS-CM2` or `hydro=fixed:median`: one row set per factor level held fixed, which is what the stage slicers read. With 5 factors of 2–30 levels that is under 60 slices per node and metric.

### Metadata to carry with every product

- Baseline period and its definition (water year, calendar year).
- Chain list with provenance: GCM run id (e.g. `r1i1p1f1`), downscaling product and version, bias-correction method and reference dataset, Source model version, calibration run id.
- Weighting rule (default: equal weight per GCM, so a GCM with three members does not count three times).
- Smoothing rule used to separate response from internal variability.

## Pre-compute pipeline

Seven stages, each idempotent and keyed by chain id, run under Snakemake or Prefect so a single failed chain can be re-run without touching the others.

1. **Ingest climate forcing.** Pull daily rainfall, PET (or Tmin/Tmax/radiation to compute it) for each `ssp × gcm × ds` from the downscaled product. Clip to subcatchment polygons with area-weighted averaging (`xagg` or `regionmask`). Write one NetCDF per chain per subcatchment set.
2. **Bias-correct.** Apply each `bc` method against the observed reference (e.g. AGCD / SILO) over 1990–2019. Check: corrected historical runs must reproduce observed monthly means and the 1st/99th percentiles within tolerance.
3. **Write Source inputs.** Convert each corrected chain to the Source input format (CSV time series per subcatchment) under `inputs/{chain_id}/`.
4. **Run the hydrological model.** For each climate chain × parameter set, set parameters and inputs, run 1990–2100, and export node results. Run in parallel across Source instances (one Veneer port per worker).
5. **Compute annual metrics.** Reduce daily outputs to the metric list per water year: annual runoff, Q90 low flow, minimum storage, e-flow event success, supply reliability.
6. **Assemble the cube.** Concatenate chains into `metrics.zarr`; compute `delta` vs each chain's own 1990–2019 mean; set `valid`.
7. **Derive products.** Run variance partitioning, quantiles, cascade envelopes, exceedance and Climate Futures tables; write Parquet; run the QA checks (Validation section) and fail the build on any breach.

### Stage 4 sketch: batch Source runs with veneer-py

```python
# worker.py — one Source instance per worker, started with Veneer on `port`
import veneer

def run_chain(port, chain_id, params, out_dir):
    v = veneer.Veneer(port=port)
    # point the project's climate inputs at this chain's files
    set_climate_inputs(v, f"inputs/{chain_id}")      # your helper: input-set or data-source swap
    for name, value in params.items():                # e.g. GR4J x1..x4 for every functional unit
        v.model.catchment.runoff.set_param_values(name, value)
    v.configure_recording(enable=[{"RecordingVariable": "Downstream Flow Volume"}])
    v.run_model(start="01/07/1990", end="30/06/2100")
    flows = v.retrieve_multiple_time_series(criteria={"RecordingVariable": "Downstream Flow Volume"})
    flows.to_parquet(f"{out_dir}/{chain_id}.parquet")
```

The input-swap call depends on how the Source project is built (scenario input sets, data sources or a plug-in); confirm it with the Source modeller before scaling out. For runs on Linux or HPC without the GUI, the Source command-line runner with a per-chain input set is the alternative.

### Stage 6 sketch: assemble the cube

```python
import xarray as xr

cube = xr.open_mfdataset("metrics/*.nc", combine="by_coords")   # one file per chain
base = cube.value.sel(year=slice(1990, 2019)).mean("year")
cube["delta"] = 100 * (cube.value - base) / base
cube["valid"] = cube.value.notnull().any("year")
cube.chunk({"node": 1, "metric": 1}).to_zarr("metrics.zarr", mode="w")
```

## Variance partitioning

For every node, metric, timescale and year, split the ensemble variance of the chosen series into one component per cascade stage plus internal variability. Start with the balanced ANOVA below (fast, transparent); move to QUALYPSO once the design is unbalanced or you need credible intervals on the shares.

$$
\sigma^2_{\text{components}}(t) = \sigma^2_{\text{SSP}} + \sigma^2_{\text{GCM}} + \sigma^2_{\text{DS}} + \sigma^2_{\text{BC}} + \sigma^2_{\text{Hydro}} + \sigma^2_{\text{Interaction}} + \underbrace{\sigma^2_{\text{IV,slow}} + \sigma^2_{\text{IV,fast}}}_{\sigma^2_{\text{Internal}}}, \qquad \sigma^2_{\text{total}}(t) = \operatorname{Var}_{\text{chains}}\big[\Delta(t)\big] = \sigma^2_{\text{components}}(t) + \sigma^2_{\text{unattributed}}(t)
$$

`total` is the empirical variance across all chains, **not** the sum of the parts. `unattributed` is what the components do not explain (residuals and fitted responses can co-vary across chains); report it, never clip it, and fail the build if its mean over years exceeds 5% of the mean total. Single years are not tested: with a few hundred chains the empirical annual variance has about 7% sampling noise.

### Step 1 — choose the timescale, then separate response from internal variability

1. **Timescale (decision D1).** The default explains the **10-year mean**; single years are secondary. Apply one centred 10-year running mean to the series, the fitted response and the residual, so internal variability of a decadal mean keeps its serial dependence (do not divide annual variance by 10). Every stage, the headline shares and the fan use the same timescale.
2. **Response.** Fit a smooth curve to each chain's series. Default: 4th-order polynomial (Hawkins & Sutton 2009). Run the estimator bank (`poly2/3/4/6`, 30-year `lowess`, and `member_mean` when there are ≥ 2 members) and publish the **range** of each share across estimators; no single set of shares is settled. A polynomial keeps a 40-year cycle as "internal" but absorbs about half of a century-long one, and a degree-4 fit to ~11 independent decades biases decadal internal variability low (see the truth table in the remediation guide).
3. **Internal variability has two parts.** *Slow*: member-to-member differences in the smooth response (`response.var("member")`), which the member-mean step would otherwise discard. *Fast*: pooled residual variance about each chain's own fit, constant in time. With a single member the slow part is not estimable: set it to 0 and carry `member_count` so the page can say so.

### Step 2 — main-effects ANOVA on the response (balanced design)

```python
def partition(delta, timescale="decadal", estimator="poly4"):
    delta, response, residual = at_timescale(delta, timescale, estimator)  # same smoothing on all three
    member_mean = response.mean("member")
    parts = {f: member_mean.mean([g for g in FACTORS if g != f]).var(f) for f in FACTORS}
    total_response = member_mean.var(FACTORS)                     # ddof=0, exact decomposition
    parts["interaction"] = total_response - sum(parts.values())   # clipped at 0 only for rounding
    parts["internal_slow"] = response.var("member").mean(FACTORS) # law of total variance: closes exactly
    parts["internal_fast"] = residual.var("year").mean()
    parts["internal"] = parts["internal_slow"] + parts["internal_fast"]
    out = xr.Dataset(parts)
    out["total"] = delta.var(FACTORS + ["member"])                # independent of the components
    out["unattributed"] = out["total"] - sum(out[c] for c in COMPONENTS)
    return out
```

Run it per (node, metric, scenario, timescale) and write the result to the `variance` table. Report the interaction term explicitly: a large interaction means "which GCM matters depends on the hydrological parameters" and is itself a finding. Run the same function for each estimator and write the horizon shares to `sensitivity`; resample GCMs with replacement (500 draws, fit once, reshuffle the GCM axis) and write the 90% interval to `bootstrap`.

### Step 3 — unbalanced designs and credible intervals: QUALYPSO

QUALYPSO (Evin et al., R package `QUALYPSO`) fits the response per chain, then estimates the main effects with a Bayesian ANOVA that tolerates missing GCM × RCM cells and returns uncertainty on every component. Run it as a separate R step that reads the cube and writes Parquet.

```r
library(QUALYPSO)
# Y: chains x years matrix of absolute values for one node and metric
# scenAvail: data.frame, one row per chain, columns ssp, gcm, ds, bc, hydro
out <- QUALYPSO(Y = Y, scenAvail = scenAvail, X = 1990:2100,
                Xfut = seq(2025, 2095, by = 10),
                listOption = list(typeChangeVariable = "rel"))
out$DECOMPVAR        # variance by component at each Xfut
```

Check argument names against the installed version; they have changed between releases. A random-effects model per horizon (`lme4::lmer(delta ~ 1 + (1|ssp) + (1|gcm) + (1|ds) + (1|bc) + (1|hydro))`) is an acceptable cross-check.

### Caveats to carry into the dashboard

- Variance from a factor with few levels is noisy: with 3 SSPs, 3 GCMs or 2 bias-correction methods, show each share with its estimator range and bootstrap interval, not as an exact figure (the demo's three-GCM bootstrap gives 25–85% for the climate share).
- The "hydrological" component is **parameter variation within one model structure**; name it "Hydrological parameters". It does not cover model structure, groundwater or management assumptions.
- Percentage change against each chain's own baseline removes baseline differences between chains; offer the absolute metric alongside it.
- The GCM ensemble is an ensemble of opportunity, not a random sample; its spread does not capture all sources of uncertainty.
- SSP variance describes scenario choice, not a probability. Label it "scenario spread".

## Dashboard views

One page per node, with a node picker, a metric picker and an SSP selector shared by all four views. Every view states its chain count ("n = 1,920 chains") and links to the chain list.

### A. Cascading variance ribbon

**Question it answers:** is the spread at a chosen horizon driven by climate forcing or by the catchment model?

- **Form:** a horizontal band that widens left to right through the stages SSP → GCM → downscaling → bias correction → hydro parameters → internal variability. Band height at each stage = P10–P90 of the cumulative ensemble; the increment added by each stage is shaded. A label on each step gives that stage's share of total variance.
- **Horizon control:** 2030s, 2050s, 2070s, 2090s (decadal mean of the response).
- **Headline:** climate share (SSP + GCM + DS + BC) vs hydrological share, e.g. "Climate 78% · Hydrology 14% · Variability 8%" — computed, never typed.
- **Data:** `cascade` table, computed as below.

```python
ORDER = ["ssp", "gcm", "ds", "bc", "hydro"]

def cascade(resp_h, iv_var, z=1.2816):            # resp_h: response averaged over one decade
    rows = []
    for k, stage in enumerate(ORDER, start=1):
        varying, fixed = ORDER[:k], ORDER[k:]
        ens = resp_h.mean(fixed + ["member"]).stack(chain=varying)
        p10, p50, p90 = ens.quantile([0.1, 0.5, 0.9], "chain").values
        rows.append(dict(stage=stage, p10=p10, p50=p50, p90=p90))
    last = rows[-1]                                  # add IV as a normal widening (approximation)
    lo = (last["p50"] - last["p10"]) ** 2 + z**2 * iv_var
    hi = (last["p90"] - last["p50"]) ** 2 + z**2 * iv_var
    rows.append(dict(stage="internal", p10=last["p50"] - lo**0.5,
                     p50=last["p50"], p90=last["p50"] + hi**0.5))
    return rows
```

The stage order changes the increments but not the shares in the `variance` table; keep the order fixed and say so in the caption.

### B. Shifting-horizon fan (Hawkins & Sutton style)

**Question it answers:** which source dominates in the near, mid and long term?

- **Upper panel:** `delta` vs year, 2020–2100. Centre line = ensemble-mean response for the selected SSP(s). Nested bands from the inside out: IV, hydro, BC, DS, GCM, SSP; each band's half-width = 1.645 × √(cumulative variance), i.e. a 90% range.
- **Lower panel:** stacked fractional-variance area chart (0–100%) on the same x-axis, one colour per source, same colours as the bands.
- **Toggle:** "Empirical P10–P90" (from `quantiles`, the default and primary display) vs "Normal-approximation bands (mean ± 1.645σ)" (from `variance`). The empirical fan is the envelope of the ensemble; the approximation assumes a bell-shaped spread that scenario mixtures and skewed runoff may not follow. Show the dotted empirical P05–P95 limits when the two widths differ by more than 10%. Say that percentile curves are calculated year by year and are not coherent drought trajectories.
- **Horizon marker:** shade the selected horizon decade on the fan, outline it on the shares chart and highlight the same decade in the breach table. A **timescale** control (10-year mean | single year) governs the fan, shares, cascade and headline together.
- **Reading and key:** a one-line reading above the fan states the median and P10–P90 at the selected horizon; the fan has its own key (reference envelope, selected chains, median, mean, dotted limits, threshold, horizon) separate from the variance-source key.

### C. Robust-decision threshold marker

**Question it answers:** how often does the system fail a limit we care about, and when does that become likely?

- **Inputs:** threshold from a preset list (town water security storage, minimum spawning-flow pulse, cease-to-pump level) or typed; breach rule chosen from four (all scored on annual values):
    1. *Annual:* share of chain-years in the decade below the threshold.
    2. *At least N dry years per decade:* share of chains with at least N below-threshold years in the decade (default N = 3), consecutive or not.
    3. *At least N consecutive dry years:* share of chains whose longest run of below-threshold years within the decade is at least N (runs are cut at the decade boundary). In the synthetic SSP2-4.5 2050s case these two give 31.7% and 16.7%.
    4. *Decadal mean:* share of chains whose decadal mean is below the threshold.

  Call the threshold a **screening threshold**: a −20% annual runoff change is not an ecological limit, supply failure point or loss of resilience. Those need a defined asset, performance measure and routing/operating context (seasonal low flows, cease-to-flow duration, inter-event periods, inundation opportunities, storage reliability, post-drought recovery).
- **Form:** the threshold drawn as a labelled line across the fan in view B, plus a decade × SSP grid of breach shares (2030s–2090s by 3 SSPs), each cell showing share and n, e.g. "38% (730 of 1,920)".
- **Data:** `exceedance` table for presets; for a typed threshold, compute in the browser from the loaded chunk.

### D. Stage slicers

**Question it answers:** what is left if we hold one source fixed?

- **Controls:** one "hold fixed" dropdown per factor (`all` or a single level) plus two presets: *Climate spread only* (hydro = median parameter set) and *Hydrological-parameter spread only* (pick one SSP × GCM × DS × BC chain, e.g. SSP2-4.5 / ACCESS-CM2).
- **Behaviour:** redraws the empirical fan in B, its mean line, the breach grid in C and the Climate Futures panel for the filtered chains; shows the filtered fan over the full fan in grey so the reduction is visible. Variance shares and the cascade are **not** re-run (decision D3) and say "Full ensemble · slicers do not apply"; panels that respond say "Sliced · n = a of b". Active filters appear as removable chips above the fan, with the controls beside it.
- **Implementation:** the client loads the (node, metric) chunk once as Arrow (1,920 chains × 111 years ≈ 0.85 MB) and computes quantiles and breach shares locally, in under 50 ms. The precomputed `quantiles` slices serve the first paint and exports.
- **Context panel:** the Climate Futures matrix for the selected horizon, highlighting the cells of the GCMs currently included.

## Tech stack and API

A Python pre-compute stack, a thin read-only API, and a browser client that does the slicing. Swap the client for Streamlit or Panel if the first goal is an internal prototype.

| Layer | Recommended | Why | Prototype alternative |
| --- | --- | --- | --- |
| Orchestration | Snakemake or Prefect | Per-chain targets, resumable, HPC-friendly | Python script with a chain manifest |
| Climate processing | xarray, dask, xagg / regionmask, xclim (bias correction via `xclim.sdba`) | Labelled n-d arrays, lazy, chunked | Same |
| Hydrology | eWater Source + veneer-py, or Source command-line runner | Existing calibrated models | Rainfall-runoff only (e.g. GR4J in `hydrogr` or Python) |
| Variance | numpy / xarray ANOVA; R `QUALYPSO` via a separate R step | Transparent first, Bayesian when needed | ANOVA only |
| Storage | Zarr (cube) + Parquet (products) on S3 / Azure Blob | Chunked reads, columnar filters | Local files |
| API | FastAPI + DuckDB over Parquet | SQL on Parquet with no database server | Streamlit reads Parquet directly |
| Client | React + D3 or Observable Plot; Apache Arrow JS for chunk transfer | Custom fans and ribbons, fast local slicing | Streamlit / Panel + Plotly |

### Accessibility

Every chart SVG carries a name and a description that states the reading. Each chart has a "View data table" panel with CSV download (fan, shares, cascade, breach grid); the filtered chain export covers the cube. Pure calculations live in `web/stats.js` with unit tests.

### Endpoints (all GET, all cacheable)

| Endpoint | Returns | Backed by |
| --- | --- | --- |
| `/nodes`, `/metrics`, `/chains` | Catalogues and chain provenance | `chains` |
| `/variance?node&metric&ssp&timescale` | Variance components by year | `variance` |
| `/cascade?node&metric&ssp&horizon&timescale` | Stage envelopes | `cascade` |
| `/quantiles?node&metric&ssp&slice&timescale` | Fan quantiles by year | `quantiles` |
| `/sensitivity?node&metric&ssp&horizon&timescale` | Shares under each response estimator | `sensitivity` |
| `/bootstrap?node&metric&ssp&horizon&timescale` | GCM-bootstrap share intervals | `bootstrap` |
| `/exceedance?node&metric&threshold_id&rule` | Breach grid (`persistent` accepted as an alias of `dry_years_per_decade`) | `exceedance` |
| `/cube?node&metric` | Arrow IPC stream of the metric's series for all chains (`delta` or `value`) | `metrics.zarr` chunk |
| `/futures?horizon&ssp` | Climate Futures matrix | `climate_futures` |

Version every product build (`build_id` in every response) so a screenshot can be traced to the chain set that produced it.

### Performance budgets

- First paint of a node page: under 1.5 s (four small Parquet queries).
- Slicer redraw: under 100 ms (local quantiles on a ~0.85 MB chunk).
- Full product rebuild after new chains: overnight batch; incremental if only one factor level is added.

## Validation, QA and communication guardrails

The build fails if any automated check fails; the guardrails are design rules every view must follow.

### Automated checks (run in pipeline stage 7)

- [ ] **Historical skill:** every chain driven by bias-corrected historical climate reproduces observed 1990–2019 mean annual flow within ±10% and the flow-duration curve Q10/Q50/Q90 within ±20% at each gauged node.
- [ ] **Parameter sets:** each hydro parameter set meets the calibration acceptance criteria (e.g. NSE ≥ 0.7 and |bias| ≤ 10%) on observed climate.
- [ ] **Completeness:** chain count per factor level matches the design; missing cells listed in the build report.
- [x] **Closure:** the mean over years of |unattributed| is below 5% of the mean total, per scenario, metric and timescale. The total is the empirical ensemble variance, so this is a real check, not a definition.
- [x] **Agreement:** normal-approximation 90% band and empirical P05–P95 differ by less than 20% at every decade; otherwise flag (reported, not a pass).
- [x] **Stability:** bootstrap over GCMs (resample with replacement, 500 draws); count variance shares whose 90% interval is wider than 30 percentage points (the demo flags 82 of 256 with three GCMs; recorded, build not failed).
- [x] **Estimator sensitivity:** range of each share across the estimator bank, recorded in `metadata.qa`.
- [ ] **Monotonic quantiles:** p05 ≤ p10 ≤ … ≤ p95 for every row.

### Communication guardrails

- Never show a single chain as "the projection". Single chains appear only through the slicers and always over the full grey envelope.
- Label SSPs as scenarios. Do not pool them into one fan without saying so, and never print a probability for an SSP.
- State n and the GCM list on every view, and say whether the panel responds to the slicers; state "ensemble of opportunity — this ensemble does not capture all sources of uncertainty".
- Show change relative to baseline by default; absolute values only with the baseline drawn.
- Use one colour per uncertainty source across all views (cascade, fan and the stacked share chart), and a neutral grey for the envelope.
- Breach shares carry their breach rule in the label ("At least 3 consecutive dry years: runs ≥ 3 below −20% in the decade").
- Every number names its timescale (10-year mean or single year) and its ensemble scope.
- Do not claim ecological resilience, a total hydrological uncertainty, or a guaranteed floor on uncertainty.

## Delivery plan

Five phases; each ends at a gate the next phase depends on. Durations are indicative for one catchment and a team of two.

| Phase | Indicative length | Deliverable | Gate to pass |
| --- | --- | --- | --- |
| 0. Design | 2 weeks | Factor matrix, Climate Futures GCM selection, metric and threshold list, chosen breach rules | Water planners sign off the metrics and thresholds |
| 1. Thin slice | 3 weeks | 1 node, 2 SSPs, 3 GCMs, 1 DS, 1 BC, 5 hydro sets run end to end; cube + ANOVA; Streamlit view B | Variance closure and historical skill checks pass |
| 2. Full cascade | 4–6 weeks | All chains for all nodes; QUALYPSO step; all Parquet products; QA report | All automated checks pass or flagged nodes are accepted |
| 3. Dashboard | 4 weeks | API + client with views A–D, Climate Futures panel, exports | Usability test with 5 planners: each answers the three purpose questions unaided |
| 4. Operate | ongoing | Rebuild on new downscaled releases or recalibration; versioned `build_id` | A rebuild reproduces the previous build's products exactly from the same inputs |

### Open questions to settle in Phase 0

- Which downscaled product(s) and bias-correction methods are authoritative for this catchment?
- Is the Source model fast enough for the full parameter dimension, or is the reduced routing set needed?
- Which thresholds and breach rules are regulatory, and which are exploratory?
- Is internal variability from GCM members, residuals, or a stochastic generator?
