"""Truth tests for the response estimators (WI-5).

Series are built with a known forced path and a known amount of natural variability,
so the table printed with `pytest -s` shows how much each estimator recovers.
"""
import numpy as np
import pytest
import xarray as xr
from hydrofan.analytics import ESTIMATORS, partition, fit_response, shares, bootstrap_shares
from hydrofan.build import demo_cube

SIGMA = 5.0


def make(kind, seed=7):
    base = demo_cube().delta
    shape, years = base.shape, base.year.values
    rng = np.random.default_rng(seed)
    if kind == "white":
        noise = rng.normal(0, SIGMA, shape)
        truth = SIGMA**2
    elif kind == "ar1":
        phi = .6
        noise = np.zeros(shape)
        noise[..., 0] = rng.normal(0, SIGMA, shape[:-1])
        for k in range(1, shape[-1]):
            noise[..., k] = phi * noise[..., k - 1] + rng.normal(0, SIGMA * np.sqrt(1 - phi**2), shape[:-1])
        truth = SIGMA**2
    else:  # slow40 / slow100: oscillation of that period, random phase per chain, variance SIGMA^2
        period = int(kind[4:])
        phase = rng.uniform(0, 2 * np.pi, shape[:-1] + (1,))
        noise = np.sqrt(2) * SIGMA * np.sin(2 * np.pi * years / period + phase)
        truth = SIGMA**2
    forced = xr.zeros_like(base) + (-30 * np.maximum(years - 2019, 0) / 81)  # same forced path for every chain
    return forced + xr.DataArray(noise, coords=base.coords, dims=base.dims), truth


def recovered(delta, estimator):
    parts = partition(delta, timescale="annual", estimator=estimator)
    return float(parts.internal.mean())


def test_estimator_report():
    table = {}
    for kind in ("white", "ar1", "slow40", "slow100"):
        delta, truth = make(kind)
        table[kind] = {e: recovered(delta, e) / truth for e in ESTIMATORS}
    print("\nShare of true natural variance recovered (annual, 1.0 = exact):")
    print(f"{'':8}" + "".join(f"{e:>13}" for e in ESTIMATORS))
    for kind, row in table.items():
        print(f"{kind:8}" + "".join(f"{row[e]:13.2f}" for e in ESTIMATORS))
    # Properties that must hold, whatever the exact numbers:
    for e in ESTIMATORS:
        assert .7 < table["white"][e] < 1.2, e              # white noise is recovered by all
    # A degree-4 polynomial cannot follow a 40-year cycle but absorbs a ~century-long one:
    # what counts as "internal" depends on the estimator and on the period of the variability.
    assert table["slow40"]["poly4"] > .85
    assert table["slow100"]["poly4"] < .6
    assert table["slow40"]["lowess"] < .6                   # a 30-year window absorbs the 40-year cycle
    for k in ("slow40", "slow100"):
        assert table[k]["member_mean"] > table[k]["poly4"]  # member contrast does not absorb it


def test_member_mean_needs_two_members():
    with pytest.raises(ValueError, match="two members"):
        fit_response(demo_cube().delta.isel(member=[0]), "member_mean")


def test_unknown_estimator_rejected():
    with pytest.raises(ValueError, match="estimator"):
        fit_response(demo_cube().delta, "spline")


def test_estimators_agree_on_forced_path():
    delta, _ = make("white")
    ref, _ = fit_response(delta, "poly4")
    for e in ("poly3", "poly6", "lowess", "member_mean"):
        resp, resid = fit_response(delta, e)
        assert float(abs(resp - ref).mean()) < 3.0, e
        np.testing.assert_allclose((resp + resid).values.shape, delta.shape)


def test_shares_sum_to_100_and_vary_by_estimator():
    cube = demo_cube().delta.sel(ssp=["SSP2-4.5"])
    seen = []
    for e in ESTIMATORS:
        s = shares(partition(cube, "decadal", e), 2050, "decadal")
        assert abs(sum(s.values()) - 100) < 1e-6
        seen.append(s["internal"])
    assert max(seen) - min(seen) > .5  # estimators genuinely disagree


def test_bootstrap_intervals_cover_point_estimate_scale():
    cube = demo_cube().delta
    point = shares(partition(cube, "decadal"), 2050, "decadal")
    draws = bootstrap_shares(cube, [2050], draws=40)[2050]
    for g, values in draws.items():
        assert len(values) == 40
        assert min(values) <= max(values)
    lo, hi = np.percentile(draws["climate"], [5, 95])
    assert hi - lo > 1  # three GCMs give a wide interval
    assert 0 <= point["internal"] <= 100


def test_numpy_bootstrap_matches_xarray_shares():
    from hydrofan.analytics import _group_shares, at_timescale, FACTORS
    cube = demo_cube().delta
    d, r, e = at_timescale(cube, "decadal")
    years = list(d.year.values)
    got = _group_shares(r.transpose(*FACTORS, "member", "year").values, float(e.var("year").mean()), [years.index(2055)])
    ref = shares(partition(cube, "decadal"), 2050, "decadal")
    for g in ref:
        np.testing.assert_allclose(got[g], ref[g], rtol=1e-9)
