# Remediation Guide — Review Findings

Companion to [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md) (the original design). This guide turns the external review of the published demo into ordered, testable work. Python tests (10) and JS tests (3) passed at review time; none of the findings below is caught by them.

## How to use this guide

- Work in the order of the **Delivery order** section. Phase 1 fixes what the graphics *compute*; later phases fix what they *say*.
- Every work item lists: the problem (with file reference), the change, tests to write **first**, and an acceptance check.
- Two findings were reproduced locally against this repo before writing (seed 42 demo cube):
  - Two smooth members ending at −10% / +10%: ensemble variance at 2100 = **100**, reported `total` = **1.5e-30** (finding 1).
  - SSP2-4.5, 2050s, threshold −20%: ≥3 dry years in the decade = **31.7%** of chains (38/120); ≥3 *consecutive* dry years = **16.7%** (20/120) (finding 2).

## Decisions to make before coding

| # | Decision | Recommendation | Affects |
| --- | --- | --- | --- |
| D1 | What quantity does the graphic explain: an individual year or a decade mean? | **Decade mean (10-year mean change) is the default**; annual is a secondary view. Horizons, cascade and headline are already decadal. | WI-3, fan, shares, cascade |
| D2 | How is slow natural variability treated? | Keep it in "internal variability" and split it into **slow (member-to-member response)** and **fast (residual)**. | WI-1 |
| D3 | Do slicers also re-run variance shares? | **No for now**: label those panels "full ensemble". Fixing one factor level leaves a balanced sub-design, so per-slice variance can be precomputed later. | WI-8 |
| D4 | Keep `persistent` as an API rule name? | Rename; accept `persistent` as a deprecated alias for one release. | WI-2 |

Record each answer in `docs/decisions.md` (one line each) so later reviewers can see the choice.

---

## Phase 1 — Correct the calculations

### WI-1 Retain member-to-member response differences (finding 1, highest priority)

**Problem.** [analytics.py:29-43](../hydrofan/analytics.py) fits every chain (members included), takes `response.mean("member")`, then measures internal variability from residuals about each chain's own polynomial. A smooth difference between members is removed from the factor variances *and* from the residuals. `total` is then defined as the sum of the parts ([analytics.py:42](../hydrofan/analytics.py)), so the closure check is circular.

**Change.**

1. In `partition`, keep `member` as a crossed factor of the response and report it:
   - `internal_slow(t)` = main effect of `member` on the response plus its interactions with the other factors (the variance that `response.mean("member")` currently discards).
   - `internal_fast` = pooled residual variance, as today.
   - `internal` = `internal_slow + internal_fast`; keep the `internal` column so the UI and API stay compatible, add the two sub-columns.
2. Compute `total` **independently**: the empirical variance across all chains of `delta` at each year (`delta.var(FACTORS + ["member"])`). Do not sum components to get it.
3. Add `unattributed = total − Σ components`. It is non-zero because residuals and fitted responses can co-vary across chains. Report it; do not clip it.
4. With a single member, `internal_slow` is undefined: set it to 0, add `member_count` to the table and metadata, and show "single realisation: slow variability not estimable" in the UI.
5. Replace the closure check in [build.py:84](../hydrofan/build.py) with: `|mean(unattributed)| / mean(total)` over all years, per scenario, below 5%, and fail the build above it. Single years are not tested: with 360 chains the empirical annual variance carries about 7% sampling noise, and the demo's worst single year is 25% off. **Status: done** (WI-1 implemented; `internal_slow`, `internal_fast`, `unattributed`, `member_count` are in the `variance` table).

**Tests first** (`tests/test_analytics.py`):

- Reviewer's case: members at ±10% (linear in `t`), all else zero → `total[-1] == 100`, `internal_slow[-1] == 100` (±1e-6), factor components 0.
- Known member effect plus a known GCM effect: recovered shares match the analytic values (extend `test_known_main_and_interaction_effects`).
- Pure white noise, no member effect → `internal_slow ≈ 0`, `internal_fast ≈ σ²`.
- Single member → `internal_slow == 0` and a `member_count == 1` flag.

**Accept when** the reviewer's example no longer reports ~0 and `unattributed/total` is under tolerance on the demo cube.

### WI-2 Make "persistent" mean what it says (finding 2)

**Problem.** [analytics.py:69-72](../hydrofan/analytics.py) counts any N below-threshold years in a decade. [web/app.js](../web/app.js) `drawBreaches` repeats the same rule, so Python and browser agree on a definition that does not match its name.

**Change.**

1. Rename the existing rule to `dry_years_per_decade` with label **"At least N dry years per decade"**.
2. Add `consecutive_run` with label **"At least N consecutive dry years"**: a chain breaches if its longest run of below-threshold years inside the decade is ≥ N. Document that runs are truncated at decade boundaries (alternative: score runs on the full series by start year; pick one and state it in the rule label).
3. Share one implementation: add `longest_run(mask)` to `hydrofan/analytics.py` and mirror it in a new pure module `web/stats.js` so the browser does not diverge.
4. Update:
   - `build.py` rule loop ([build.py:64](../hydrofan/build.py)): `["annual", "dry_years_per_decade", "consecutive_run", "decadal_mean"]`.
   - `api.py` `/exceedance` rule parameter: validate against the four names; map `persistent` → `dry_years_per_decade`.
   - `web/index.html` rule `<select>` and the `rule-label` text in `drawBreaches`.
   - Existing tests that pass `'persistent'`.
5. Optionally report `max_run_years` percentiles per decade so users see duration, not just a threshold count.

**Tests first.**

- `[1,1,0,1,0,0,0,0,0,0]` (dry=1): `dry_years_per_decade(3)` true, `consecutive_run(3)` false; `[0,1,1,1,0,…]` true for both.
- Runs of length 1, N = decade length, and a run touching both decade edges.
- Python/JS parity: a shared fixture JSON of mask vectors with expected results, asserted in both `tests/test_analytics.py` and `tests/static-products.test.mjs`.
- Regression: on the seed-42 cube (SSP2-4.5, 2050s, −20%) expect **31.7% / 16.7%** for the two rules (confirm after any change to `demo_cube`).

**Status: done** (Python, `web/stats.js`, API alias, export; parity fixture in `tests/fixtures/breach_rules.json`). Rule parameter in code is `years`; the HTML id `persistent` is unchanged.

**Accept when** both rules appear in the UI with their own labels and denominators, and the table above is reproduced.

### WI-3 One timescale across every stage (finding 3)

**Problem.** [analytics.py:46-59](../hydrofan/analytics.py) builds the climate/hydro envelopes from **decade-mean** fitted responses, then adds `residual.var("year").mean()`, an **annual** residual variance. The headline shares in [web/app.js](../web/app.js) `drawCascade` average annual-based variances over the decade, so share labels are on yet another basis.

**Change (assuming D1 = decade mean).**

1. Add a `timescale` argument (`"decadal"` default, `"annual"`) to `partition` and `cascade`, and a `timescale` column to the `variance`, `quantiles` and `cascade` tables.
2. Decadal internal variability: average residuals over non-overlapping 10-year blocks per chain, then take the variance of those block means pooled over chains and blocks. This preserves serial dependence automatically (do not scale annual variance by 1/10).
3. Decadal `variance` series: compute response components on the 10-year-mean response (centred running mean for the yearly plot) and add decadal internal variability.
4. `cascade`: reuse the same decadal IV for the final stage; keep the normal approximation but label it (WI-4).
5. Empirical fan and quantiles for the decadal view use the centred 10-year running mean of each chain's `delta` (years with incomplete windows dropped).
6. UI: one control "Timescale: 10-year mean | Single year" governing fan, shares, cascade and headline together. The breach table stays annual-scoped by rule and says so.
7. Caption the relationship: single-year uncertainty ≥ decadal-mean uncertainty because annual noise averages down.

**Tests first.**

- AR(1) residuals with known φ: decadal IV from block means matches the analytic variance of the mean within sampling tolerance, and is larger than `σ²/10` when φ > 0.
- White noise: decadal IV ≈ `σ²/10`.
- Annual and decadal `internal_fast` are not equal on the demo cube (guards against silently reusing the annual value).

**Status: done.** Deviations from the plan above, for the record:

- Decadal series use the centred 10-year **running** mean (label year `y` = mean of `y−5…y+4`, so the 2050s window is labelled 2055) for the response, residual and delta alike, rather than non-overlapping blocks. It gives the same expectation and one definition for IV, quantiles and totals. Decadal years run 1995–2096.
- Breach rules stay annual; the page says so.
- A degree-4 polynomial fit to ~11 independent decades absorbs a large share of decadal variance, so decadal `internal_fast` is biased low (tests assert 50–100% of the analytic value, and that AR(1) vs white-noise ratios match). Carry this into WI-5.
- Demo effect: IV share for the 2050s is 11% on 10-year means and 54% for single years.

**Accept when** every number on the page says which timescale it is on, and switching the control changes the fan, shares, cascade and headline together.

---

## Phase 2 — Say only what is computed

### WI-4 Percentiles vs statistical intervals (finding 4)

- Rename the fan mode `Partitioned 90% bands` → **"Normal-approximation bands (mean ± 1.645σ)"** in [web/index.html](../web/index.html) and the `names`/captions in [web/app.js](../web/app.js). Keep empirical P10–P90 as the default and first option.
- Add caption text under the fan: *"Percentile curves are calculated year by year; the chain forming P90 can change between years. They are not coherent drought trajectories."*
- Replace "range is a lower bound" with **"This ensemble does not capture all sources of uncertainty."** in the footer ([web/index.html](../web/index.html)), README, and the two matching lines in [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md) (lines 216 and 333).
- Rename the QA "agreement" check and flag text to "empirical vs normal-approximation width".
- **Status: done** (`tests/test_copy.py` guards the wording).

Acceptance: grep for `lower bound` and `Partitioned 90%` returns nothing in `web/`, `README.md`, `docs/`.

### WI-5 Test the variability estimator and show its sensitivity (finding 5)

1. **Estimator bank.** Make `split_response` pluggable: `poly2`, `poly3`, `poly4` (current), `poly6`, `lowess` (30-year window), and `member_mean` (ensemble-mean across members of the same SSP×GCM×DS×BC×hydro cell, requires ≥2 members).
2. **Synthetic truth tests** (`tests/test_estimators.py`): generate series with a known forced path plus (a) white noise, (b) AR(1), (c) a slow oscillation (~40-year period) as "natural" variability. Report per estimator the error in recovered IV variance and in the IV share. Assert only properties that must hold (e.g. `poly4` underestimates (c)); print the table so the limitation is visible.
3. **Sensitivity output.** Run the pipeline for each estimator and for annual vs decadal timescale; write `sensitivity.parquet` with `min`, `max` of each variance share per decade. Add `qa.estimator_sensitivity` to `metadata.json`.
4. **UI.** Show shares as ranges where sensitivity is available, e.g. "Variability 8% (5–14%)", with a tooltip listing the estimators. Remove single-point percentages from the headline.
5. **Bootstrap.** Implement the GCM bootstrap listed in the original guide's QA section (500 draws, resampling GCMs); today `bootstrap_stability` is "not implemented" ([build.py:88](../hydrofan/build.py)). Until it exists, state "no uncertainty intervals" beside the shares (already in the provenance text).

Accept when the same share can be seen changing under alternative estimators on the page, and the test output documents where `poly4` fails.

### WI-6 Rename "Hydrology" and add absolute values (finding 6)

- Rename the display name to **"Hydrological parameters"** (`names.hydro`, the cascade stage label, headline text, slicer label, README, guide). Keep the internal key `hydro`.
- Headline: `Climate X% · Hydrological parameters Y% · Internal variability Z% · Interactions W%`.
- Add the footnote near the cascade: *"Parameter sets within one model structure. Model structure, groundwater and management assumptions are not sampled."*
- Normalisation note under every percentage-change chart: *"Each chain is expressed relative to its own 1990–2019 mean, so baseline differences between chains are removed."*
- Absolute values: the cube already stores `value`. Add a second metric `annual_runoff_abs` (units labelled; the synthetic demo uses an index, say so) through `build.py` tables, `/metrics`, and the metric `<select>`. Show the baseline spread (P10–P90 of the 1990–2019 mean across chains) next to it.
- **Status: done.** Both metrics run through every table, the API and the static bundle (`bundle.cubes`); breach screening applies to the % metric only and says so. Baseline spread is in `metadata.baseline_spread_abs`.
- Tests: `/metrics` lists both; absolute and relative products have different `metric` keys and units.

### WI-7 Honest scope on ecological and decision claims (finding 7)

- [web/index.html](../web/index.html) subtitle → **"Trace the sources of uncertainty in future runoff, and explore runoff sensitivity."**
- Rename "Robust-decision threshold" copy to "Runoff-change screening threshold". Section C heading: *"How often is a runoff-change threshold crossed?"* Add one sentence: *"A −20% annual runoff change is a screening level, not an ecological limit or supply failure point."*
- Add a "Scope and limitations" panel (inside the provenance `<details>`): annual runoff only; no routing, storage or operating rules; no seasonal or event metrics.
- Roadmap (do not implement in the demo): `low_flow_q90`, `cease_to_flow_days`, `max_interevent_days`, `floodplain_inundation_events`, `storage_reliability`, `post_drought_recovery`. Each needs a defined asset, performance measure, and routing/operating context (see the metric cube in the original guide). Add them to Phase 0 of the delivery plan as "named assets and their performance measures".
- **Status: done** (subtitle, section C copy, scope-and-limitations list in the provenance panel).
- Acceptance: no occurrence of "resilience" or "robust" in user-facing copy unless tied to a defined measure.

---

## Phase 3 — Page structure and controls (finding 8)

Pure client work in `web/`. Do WI-9 first: it makes the rest testable.

### WI-9 Extract pure functions (enabler)

Move `quantile`, `fanData`, `longest_run` equivalents, and breach counting out of [web/app.js](../web/app.js) into `web/stats.js` with unit tests in `tests/` (Node test runner, as `static-products.test.mjs` does). `app.js` keeps DOM and drawing only.

### WI-8 Layout, scope cues, and legends

| Item | Change |
| --- | --- |
| Fan above the fold | Shrink the intro; order: notice → fan with controls → cascade → breaches → provenance. |
| Controls beside the fan | Move slicers into a side column of the fan card on desktop (stack below on narrow screens). Show active selections as removable chips above the fan ("GCM: ACCESS-CM2 ×"). |
| Contradictory scope cues | Replace the repeated `.chain-note` with a per-panel scope badge: **"Full ensemble · n = 360"** on cascade and shares; **"Sliced · n = 30 of 360"** on fan, breaches, futures. |
| Dashed mean | Draw the mean of the *filtered* chains and label it "Mean of selected chains"; when no slicers are active, keep the response mean and label it "Ensemble mean response". Drop the unsliced dashed line when sliced. |
| Fan legend | New legend scoped to the fan: reference envelope (grey), selected-chain P10–P90 (green), median, mean, dotted P05/P95 (shown on width disagreement), threshold line. Keep the variance-source legend only beside the shares and normal-approximation view. |
| Horizon marker | Shade the selected horizon decade on the fan and highlight the matching decade column in the breach table; label the shaded band "2050s selected". |
| Accessibility | Give each SVG `aria-labelledby` pointing to `<title>` and `<desc>` that state what is plotted and the key reading (e.g. median change and range at the selected horizon). Add "View data table" (a visually hidden `<table>`, toggled by a button) and "Download CSV" per panel; the existing export covers only chains. |

Tests: `web/stats.js` unit tests for the mean-of-selected-chains calculation; a Playwright (or browser-pane) smoke check that, with a GCM slicer set, the scope badges on the cascade and fan differ, and that each `<svg>` has a non-empty accessible name.

---

## Cross-cutting changes

- **Schema versioning.** Add `schema_version: 2` to `metadata.json` and API envelopes; the build ID already hashes `build.py` and `analytics.py`, so it changes automatically. Bump the API version in [api.py:25](../hydrofan/api.py).
- **Static export.** [export_static.py](../hydrofan/export_static.py) and `web/static-products.js` filter by arbitrary query keys, so new columns (`timescale`, `rule`) work if the export includes them; add a test in `tests/test_static_export.py` for each new column and rule.
- **Docs.** After Phase 1 and 2, update [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md): variance section (member component, independent total), view C rules, caveats, and QA closure wording.
- **CI.** `pages.yml` runs the existing tests; add the new test files. Pages publishing stays disabled while the repository is private (see `cffbdfe`).

## Delivery order

| Step | Work items | Gate |
| --- | --- | --- |
| 1 | D1–D4 decisions; WI-1 | Reviewer's ±10% member case reports total 100; `unattributed` within tolerance |
| 2 | WI-2 | Two persistence rules; 31.7% / 16.7% reproduced; Python/JS parity fixture passes |
| 3 | WI-3 | Timescale control moves fan, shares, cascade, headline together |
| 4 | WI-4, WI-6, WI-7 (copy and labels) | Text greps in WI-4 and WI-7 clean; absolute metric present |
| 5 | WI-5 | Sensitivity ranges on page; estimator test table in CI output |
| 6 | WI-9 then WI-8 | Smoke checks pass; fan visible without scrolling at 1440×900 and 390×844 |
| 7 | Doc refresh, re-publish | `npm test` and `pytest` green; new `build_id` recorded |

Steps 1–3 change numbers; 4 and 6 change presentation only and can proceed in parallel with 5 by a second person once step 3 has landed.

## Definition of done

- Every number on the page names its timescale, ensemble scope and rule.
- `total` variance is computed independently of its parts, and the build fails when attribution does not close.
- Persistence is reported as two distinct, correctly labelled rules.
- Variance shares appear with estimator sensitivity, not as single settled percentages.
- No copy claims ecological resilience, a hydrological uncertainty total, or a mathematical lower bound.
