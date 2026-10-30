import numpy as np
import pytest
from hydrofan.analytics import COMPONENTS, normalise, partition, breaches
from hydrofan.build import demo_cube


def test_baseline_and_closure():
    cube=demo_cube()
    np.testing.assert_allclose(cube.delta.sel(year=slice(1990,2019)).mean('year'),0,atol=1e-12)
    parts=partition(cube.delta)
    np.testing.assert_allclose(sum(parts[c] for c in COMPONENTS),parts.total,rtol=.001)
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
    assert breaches(values,5,'persistent',3)['breach_share']==.5
    assert breaches(values,5,'decadal_mean')['breach_share']==.5
    assert breaches(values,0)['n_breach']==0  # strictly below
    with pytest.raises(ValueError):
        breaches(values,5,'persistent',5)


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
