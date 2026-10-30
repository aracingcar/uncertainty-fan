"""Balanced, equal-weight ANOVA. Reject incomplete designs instead of filling cells."""
import numpy as np
import xarray as xr

FACTORS = ["ssp", "gcm", "ds", "bc", "hydro"]
COMPONENTS = FACTORS + ["interaction", "internal"]
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


def partition(delta):
    """Split ensemble variance of `delta` by year.

    Forced components come from the member-mean response. Member-to-member
    differences in the smooth response are kept as `internal_slow` (law of total
    variance, so the response-level split is exact); residuals about each
    chain's own fit are `internal_fast`. `total` is the empirical variance across
    all chains, not a sum of parts, and `unattributed` reports what is left.
    """
    if not np.isfinite(delta).all():
        raise ValueError("Balanced ANOVA requires a complete, finite crossed design; use QUALYPSO for missing cells")
    response, residual = split_response(delta)
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
    return result


def cascade(delta, horizon):
    response, residual = split_response(delta)
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


def breaches(values, threshold, rule="annual", persistent_years=3):
    """values: chains × years, equal chain counts per GCM required."""
    values = np.asarray(values)
    if values.ndim != 2 or not np.isfinite(values).all() or not len(values):
        raise ValueError("Expected nonempty finite chain-year matrix")
    if rule == "annual":
        mask = values < threshold
    elif rule == "persistent":
        if not 1 <= persistent_years <= values.shape[1]:
            raise ValueError("Invalid persistent-year count")
        mask = (values < threshold).sum(axis=1) >= persistent_years
    elif rule == "decadal_mean":
        mask = values.mean(axis=1) < threshold
    else:
        raise ValueError("Unknown breach rule")
    return dict(n_breach=int(mask.sum()), denominator=int(mask.size),
                n_chains=len(values), breach_share=float(mask.mean()))
