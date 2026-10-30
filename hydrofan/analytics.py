"""Balanced, equal-weight ANOVA. Reject incomplete designs instead of filling cells."""
import numpy as np
import xarray as xr

FACTORS = ["ssp", "gcm", "ds", "bc", "hydro"]
COMPONENTS = FACTORS + ["interaction", "internal"]
TIMESCALES = ["decadal", "annual"]
WINDOW = 10  # years in a decadal mean
EXTRA = ["internal_slow", "internal_fast", "unattributed"]


def normalise(value):
    baseline = value.sel(year=slice(1990, 2019)).mean("year")
    if not np.isfinite(baseline).all() or (baseline <= 0).any():
        raise ValueError("Every chain needs a finite, positive 1990–2019 baseline")
    return 100 * (value - baseline) / baseline


def split_response(delta, degree=4):
    # Centre years before polynomial fitting for numerical stability.
    axis = delta.get_axis_num("year")
    years = delta.year.values
    x = (years - years.mean()) / np.ptp(years)
    y = np.moveaxis(delta.values, axis, 0)
    design = np.polynomial.polynomial.polyvander(x, degree)
    coef = np.linalg.lstsq(design, y.reshape(len(years), -1), rcond=None)[0]
    values = np.moveaxis((design @ coef).reshape(y.shape), 0, axis)
    response = xr.DataArray(values, coords=delta.coords, dims=delta.dims)
    return response, delta - response


ESTIMATORS = ["poly2", "poly3", "poly4", "poly6", "lowess", "member_mean"]
DEFAULT_ESTIMATOR = "poly4"


def _local_linear_matrix(years, span=30):
    """Smoother matrix of a tricube local-linear fit over the `span` nearest years."""
    years = np.asarray(years, float)
    n = len(years)
    k = min(n, span)
    smoother = np.zeros((n, n))
    for i, t in enumerate(years):
        d = np.abs(years - t)
        h = max(np.sort(d)[k - 1], 1.0) * 1.0001
        w = np.clip(1 - (d / h) ** 3, 0, None) ** 3
        X = np.stack([np.ones(n), years - t])
        smoother[i] = (np.linalg.pinv((X * w) @ X.T) @ (X * w))[0]
    return smoother


def fit_response(delta, estimator=DEFAULT_ESTIMATOR):
    """Split `delta` into (forced response, residual) with one of ESTIMATORS.

    Every estimator is an assumption about what counts as slow forced change:
    compare them (see `sensitivity`) before trusting a single set of shares.
    """
    if estimator not in ESTIMATORS:
        raise ValueError(f"estimator must be one of {ESTIMATORS}")
    if estimator.startswith("poly"):
        return split_response(delta, int(estimator[4:]))
    if estimator == "lowess":
        axis = delta.get_axis_num("year")
        smoother = _local_linear_matrix(delta.year.values)
        values = np.moveaxis(np.tensordot(smoother, np.moveaxis(delta.values, axis, 0), axes=(1, 0)), 0, axis)
        response = xr.DataArray(values, coords=delta.coords, dims=delta.dims)
        return response, delta - response
    members = delta.sizes["member"]
    if members < 2:
        raise ValueError("member_mean needs at least two members")
    response = delta.mean("member").expand_dims(member=delta.member).transpose(*delta.dims)
    # Deviations from a mean of M members understate member variance by (M-1)/M.
    return response, (delta - response) * np.sqrt(members / (members - 1))


def decadal_mean(x):
    """Centred 10-year running mean (window year-5..year+4); drops years without a full window."""
    return x.rolling(year=WINDOW, center=True).mean().dropna("year", how="any")


def at_timescale(delta, timescale, estimator=DEFAULT_ESTIMATOR):
    """Return (delta, response, residual) on one timescale.

    Decadal: every series is smoothed with the same running mean, so residual
    variance keeps its serial dependence (not annual variance divided by 10).
    """
    if timescale not in TIMESCALES:
        raise ValueError(f"timescale must be one of {TIMESCALES}")
    response, residual = fit_response(delta, estimator)
    if timescale == "annual":
        return delta, response, residual
    return decadal_mean(delta), decadal_mean(response), decadal_mean(residual)


def _parts(delta, response, residual, years=None):
    """Variance components from an already-fitted split; `years` limits the output years."""
    member_mean = response.mean("member")
    fast = residual.var("year").mean()  # pooled over all years, then constant
    if years is not None:
        delta, response, member_mean = (a.sel(year=years) for a in (delta, response, member_mean))
    parts = {f: member_mean.mean([g for g in FACTORS if g != f]).var(f) for f in FACTORS}
    total_response = member_mean.var(FACTORS)
    interaction = total_response - sum(parts.values())
    if float(interaction.min()) < -1e-8:
        raise ValueError("Negative interaction variance")
    parts["interaction"] = interaction.clip(min=0)
    slow = response.var("member").mean(FACTORS)
    parts["internal_slow"] = slow
    parts["internal_fast"] = fast + 0 * total_response
    parts["internal"] = slow + parts["internal_fast"]
    result = xr.Dataset(parts)
    result["total"] = delta.var(FACTORS + ["member"])
    result["unattributed"] = result["total"] - sum(result[c] for c in COMPONENTS)
    result["member_count"] = delta.sizes["member"]
    return result


def partition(delta, timescale="decadal", estimator=DEFAULT_ESTIMATOR):
    """Split ensemble variance of `delta` by year.

    Forced components come from the member-mean response. Member-to-member
    differences in the smooth response are kept as `internal_slow` (law of total
    variance, so the response-level split is exact); residuals about each
    chain's own fit are `internal_fast`. `total` is the empirical variance across
    all chains, not a sum of parts, and `unattributed` reports what is left.
    """
    if not np.isfinite(delta).all():
        raise ValueError("Balanced ANOVA requires a complete, finite crossed design; use QUALYPSO for missing cells")
    delta, response, residual = at_timescale(delta, timescale, estimator)
    result = _parts(delta, response, residual)
    result.attrs.update(timescale=timescale, estimator=estimator)
    return result


GROUPS = {"climate": ["ssp", "gcm", "ds", "bc"], "hydro": ["hydro"], "internal": ["internal"], "interaction": ["interaction"]}


def horizon_years(horizon, timescale):
    """Years of a partition that describe the decade `horizon`…`horizon`+9."""
    return [horizon + 5] if timescale == "decadal" else list(range(horizon, horizon + 10))


def shares(parts, horizon, timescale):
    """Percent shares of attributed variance for a horizon, as the dashboard headline shows them."""
    sel = parts.sel(year=horizon_years(horizon, timescale))
    means = {c: float(sel[c].mean()) for c in COMPONENTS}
    total = sum(means.values())
    shares_ = {c: 100 * v / total if total else 0.0 for c, v in means.items()}
    return {g: sum(shares_[c] for c in members) for g, members in GROUPS.items()}


def _group_shares(resp, fast, year_idx):
    """Numpy equivalent of shares(_parts(...)) for one set of years; `resp` is factors+member+year."""
    resp = resp[..., year_idx]
    mm = resp.mean(axis=5)                                   # member-mean response: ssp,gcm,ds,bc,hydro,year
    comp = {}
    for k, f in enumerate(FACTORS):
        others = tuple(a for a in range(5) if a != k)
        comp[f] = mm.mean(axis=others).var(axis=0).mean()
    inter = mm.var(axis=tuple(range(5))).mean() - sum(comp.values())
    comp["interaction"] = max(inter, 0.0)
    comp["internal"] = resp.var(axis=5).mean() + fast
    total = sum(comp.values())
    return {g: 100 * sum(comp[c] for c in members) / total for g, members in GROUPS.items()}


def bootstrap_shares(delta, horizons, timescale="decadal", draws=500, seed=0, estimator=DEFAULT_ESTIMATOR):
    """Resample GCMs with replacement and return share draws per horizon.

    The response/residual split is estimated once; each draw only reshuffles the GCM
    axis of the fitted arrays (the GCMs are the units being resampled).
    """
    delta, response, residual = at_timescale(delta, timescale, estimator)
    resp = response.transpose(*FACTORS, "member", "year").values
    fast = float(residual.var("year").mean())
    years = list(delta.year.values)
    index = {h: [years.index(y) for y in horizon_years(h, timescale)] for h in horizons}
    rng = np.random.default_rng(seed)
    n = resp.shape[1]
    out = {h: {g: [] for g in GROUPS} for h in horizons}
    for _ in range(draws):
        sample = resp[:, rng.integers(0, n, n)]
        for h in horizons:
            for g, value in _group_shares(sample, fast, index[h]).items():
                out[h][g].append(value)
    return out


def cascade(delta, horizon, timescale="decadal", estimator=DEFAULT_ESTIMATOR):
    if timescale not in TIMESCALES:
        raise ValueError(f"timescale must be one of {TIMESCALES}")
    response, residual = fit_response(delta, estimator)
    if timescale == "decadal":
        residual = decadal_mean(residual)  # variance of a decadal mean, not of a single year
    decade = response.sel(year=slice(horizon, horizon + 9)).mean("year")
    rows = []
    for i, stage in enumerate(FACTORS):
        ensemble = decade.mean(FACTORS[i + 1:] + ["member"]).values.ravel()
        lo, median, hi = np.quantile(ensemble, [.1, .5, .9])
        rows.append(dict(stage=stage, p10=lo, p50=median, p90=hi, order=i))
    last = rows[-1]
    slow = response.var("member").mean(FACTORS).sel(year=slice(horizon, horizon + 9)).mean("year")
    iv = float(residual.var("year").mean() + slow)
    rows.append(dict(stage="internal", order=5, p50=last["p50"],
                     p10=last["p50"] - np.sqrt((last["p50"]-last["p10"])**2 + 1.2816**2*iv),
                     p90=last["p50"] + np.sqrt((last["p90"]-last["p50"])**2 + 1.2816**2*iv)))
    return rows


RULES = ["annual", "dry_years_per_decade", "consecutive_run", "decadal_mean"]
RULE_ALIASES = {"persistent": "dry_years_per_decade"}  # deprecated; remove after one release


def longest_run(mask):
    """Longest run of True along the last axis."""
    mask = np.asarray(mask, dtype=bool)
    best = np.zeros(mask.shape[:-1], dtype=int)
    run = np.zeros_like(best)
    for k in range(mask.shape[-1]):
        run = np.where(mask[..., k], run + 1, 0)
        best = np.maximum(best, run)
    return best


def breaches(values, threshold, rule="annual", years=3):
    """values: chains × years (one decade); equal chain counts per GCM required.

    dry_years_per_decade: any `years` below-threshold years. consecutive_run: `years`
    in a row, truncated at the decade boundary.
    """
    values = np.asarray(values)
    rule = RULE_ALIASES.get(rule, rule)
    if values.ndim != 2 or not np.isfinite(values).all() or not len(values):
        raise ValueError("Expected nonempty finite chain-year matrix")
    if rule == "annual":
        mask = values < threshold
    elif rule in ("dry_years_per_decade", "consecutive_run"):
        if not 1 <= years <= values.shape[1]:
            raise ValueError("Invalid dry-year count")
        dry = values < threshold
        mask = (dry.sum(axis=1) if rule == "dry_years_per_decade" else longest_run(dry)) >= years
    elif rule == "decadal_mean":
        mask = values.mean(axis=1) < threshold
    else:
        raise ValueError("Unknown breach rule")
    return dict(n_breach=int(mask.sum()), denominator=int(mask.size),
                n_chains=len(values), breach_share=float(mask.mean()))
