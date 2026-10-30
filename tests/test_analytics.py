import numpy as np
import pytest
from hydrofan.analytics import COMPONENTS, normalise, partition, breaches
from hydrofan.build import demo_cube


def test_baseline_and_closure():
    cube=demo_cube()
    np.testing.assert_allclose(cube.delta.sel(year=slice(1990,2019)).mean('year'),0,atol=1e-12)
    parts=partition(cube.delta)
    np.testing.assert_allclose(sum(parts[c] for c in COMPONENTS)+parts.unattributed,parts.total,rtol=1e-9)
    assert all(float(parts[c].min())>=0 for c in COMPONENTS)
    assert float(parts.ssp[-1])>float(parts.ssp[30])


def test_single_scenario_has_no_scenario_variance():
    parts=partition(demo_cube().delta.sel(ssp=['SSP2-4.5']))
    np.testing.assert_allclose(parts.ssp,0)


def test_missing_design_rejected():
    delta=demo_cube().delta.copy()
    delta.values.flat[0]=np.nan
    with pytest.raises(ValueError,match='complete'):
        partition(delta)


def test_zero_baseline_rejected():
    with pytest.raises(ValueError,match='baseline'):
        normalise(demo_cube().value*0)


def test_breach_rules_have_distinct_denominators():
    values=np.array([[0,0,0,10],[10,10,10,10]])
    assert breaches(values,5,'annual')==dict(n_breach=3,denominator=8,n_chains=2,breach_share=3/8)
    assert breaches(values,5,'dry_years_per_decade',3)['breach_share']==.5
    assert breaches(values,5,'decadal_mean')['breach_share']==.5
    assert breaches(values,0)['n_breach']==0  # strictly below
    with pytest.raises(ValueError):
        breaches(values,5,'dry_years_per_decade',5)


def test_known_main_and_interaction_effects():
    import xarray as xr
    delta=xr.zeros_like(demo_cube().delta)
    g=xr.DataArray([-1.,0.,1.],dims='gcm',coords={'gcm':delta.gcm})
    h=xr.DataArray([-2.,-1.,0.,1.,2.],dims='hydro',coords={'hydro':delta.hydro})
    t=(delta.year-1990)/110
    delta=delta+(2*g+3*h+4*g*h)*t
    parts=partition(delta)
    np.testing.assert_allclose(parts.gcm[-1],4*2/3,rtol=1e-10)
    np.testing.assert_allclose(parts.hydro[-1],9*2,rtol=1e-10)
    np.testing.assert_allclose(parts.interaction[-1],16*2/3*2,rtol=1e-10)
    np.testing.assert_allclose(parts.internal,0,atol=1e-24)


def _linear_members(effects):
    import xarray as xr
    delta=xr.zeros_like(demo_cube().delta)
    m=xr.DataArray(effects,dims='member',coords={'member':delta.member})
    return delta+m*(delta.year-1990)/110


def test_member_response_difference_is_retained():
    delta=_linear_members([-10.,10.])
    parts=partition(delta)
    np.testing.assert_allclose(parts.total[-1],100,rtol=1e-9)
    np.testing.assert_allclose(parts.internal_slow[-1],100,rtol=1e-9)
    np.testing.assert_allclose(parts.internal[-1],100,rtol=1e-9)
    np.testing.assert_allclose(parts.unattributed[-1],0,atol=1e-9)
    for f in ['ssp','gcm','ds','bc','hydro','interaction']:
        np.testing.assert_allclose(parts[f],0,atol=1e-9)


def test_member_effect_alongside_gcm_effect():
    import xarray as xr
    delta=_linear_members([-3.,3.])
    g=xr.DataArray([-1.,0.,1.],dims='gcm',coords={'gcm':delta.gcm})
    delta=delta+2*g*(delta.year-1990)/110
    parts=partition(delta)
    np.testing.assert_allclose(parts.gcm[-1],4*2/3,rtol=1e-9)
    np.testing.assert_allclose(parts.internal_slow[-1],9,rtol=1e-9)


def test_white_noise_is_fast_variability():
    import xarray as xr
    cube=demo_cube().delta
    noise=np.random.default_rng(1).normal(0,5,cube.shape)
    parts=partition(xr.DataArray(noise,coords=cube.coords,dims=cube.dims))
    assert float(parts.internal_slow.max())<.12*25  # polynomial fits absorb a little noise: known estimator bias
    np.testing.assert_allclose(parts.internal_fast,25,rtol=.1)
    assert abs(float(parts.unattributed.mean()))<.15*25


def test_single_member_flags_slow_variability_unestimable():
    parts=partition(demo_cube().delta.isel(member=[0]))
    np.testing.assert_allclose(parts.internal_slow,0,atol=1e-12)
    assert int(parts.member_count)==1


def test_total_is_independent_of_components():
    cube=demo_cube().delta
    parts=partition(cube)
    np.testing.assert_allclose(parts.total,cube.var(['ssp','gcm','ds','bc','hydro','member']))
    # Single years carry sampling noise (about 7% for 360 chains); judge the bias over all years.
    assert abs(float(parts.unattributed.mean()))/float(parts.total.mean())<.05


def test_consecutive_differs_from_dry_years():
    values=np.array([[-30,-30,0,-30,0,0,0,0,0,0],[0,-30,-30,-30,0,0,0,0,0,0]])
    assert breaches(values,-20,'dry_years_per_decade',3)['n_breach']==2
    assert breaches(values,-20,'consecutive_run',3)['n_breach']==1
    assert breaches(values,-20,'persistent',3)==breaches(values,-20,'dry_years_per_decade',3)


def test_seed42_persistence_regression():
    d=demo_cube().delta.sel(ssp='SSP2-4.5',year=slice(2050,2059)).values.reshape(-1,10)
    assert breaches(d,-20,'dry_years_per_decade',3)['n_breach']==38
    assert breaches(d,-20,'consecutive_run',3)['n_breach']==20
    assert breaches(d,-20)['denominator']==len(d)*10


def test_shared_fixture():
    import json,pathlib
    from hydrofan.analytics import longest_run
    for c in json.loads(pathlib.Path(__file__).with_name('fixtures').joinpath('breach_rules.json').read_text()):
        dry=np.array([c['dry']],bool); v=np.where(dry,-30.,0.)
        assert int(longest_run(dry)[0])==c['longest_run']
        assert bool(breaches(v,-20,'dry_years_per_decade',c['n'])['n_breach'])==c['dry_years_per_decade']
        assert bool(breaches(v,-20,'consecutive_run',c['n'])['n_breach'])==c['consecutive_run']
