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


def decadal_mean(x):
    """Centred 10-year running mean (window year-5..year+4); drops years without a full window."""
    return x.rolling(year=WINDOW, center=True).mean().dropna("year", how="any")


def at_timescale(delta, timescale):
    """Return (delta, response, residual) on one timescale.

    Decadal: every series is smoothed with the same running mean, so residual
    variance keeps its serial dependence (not annual variance divided by 10).
    """
    if timescale not in TIMESCALES:
        raise ValueError(f"timescale must be one of {TIMESCALES}")
    response, residual = split_response(delta)
    if timescale == "annual":
        return delta, response, residual
    return decadal_mean(delta), decadal_mean(response), decadal_mean(residual)


def partition(delta, timescale="decadal"):
    """Split ensemble variance of `delta` by year.

    Forced components come from the member-mean response. Member-to-member
    differences in the smooth response are kept as `internal_slow` (law of total
    variance, so the response-level split is exact); residuals about each
    chain's own fit are `internal_fast`. `total` is the empirical variance across
    all chains, not a sum of parts, and `unattributed` reports what is left.
    """
    if not np.isfinite(delta).all():
        raise ValueError("Balanced ANOVA requires a complete, finite crossed design; use QUALYPSO for missing cells")
    delta, response, residual = at_timescale(delta, timescale)
    member_mean = response.mean("member")
    parts = {f: member_mean.mean([g for g in FACTORS if g != f]).var(f) for f in FACTORS}
    total_response = member_mean.var(FACTORS)
    interaction = total_response - sum(parts.values())
    if float(interaction.min()) < -1e-8:
        raise ValueError("Negative interaction variance")
    parts["interaction"] = interaction.clip(min=0)
    slow = response.var("member").mean(FACTORS)
    fast = residual.var("year").mean() + 0 * total_response
    parts["internal_slow"] = slow
    parts["internal_fast"] = fast
    parts["internal"] = slow + fast
    result = xr.Dataset(parts)
    result["total"] = delta.var(FACTORS + ["member"])
    result["unattributed"] = result["total"] - sum(result[c] for c in COMPONENTS)
    result["member_count"] = delta.sizes["member"]
    result.attrs["timescale"] = timescale
    return result


def cascade(delta, horizon, timescale="decadal"):
    if timescale not in TIMESCALES:
        raise ValueError(f"timescale must be one of {TIMESCALES}")
    response, residual = split_response(delta)
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
