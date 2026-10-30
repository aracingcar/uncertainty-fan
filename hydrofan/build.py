"""Reproducible demonstration release. No Source runs or observed skill claims."""
import argparse
import hashlib
import itertools
import tempfile
import json
from pathlib import Path
import numpy as np
import pandas as pd
import xarray as xr
from .analytics import RULES, TIMESCALES, FACTORS, COMPONENTS, EXTRA, at_timescale, normalise, partition, cascade, breaches, split_response

LEVELS = {"ssp": ["SSP1-2.6", "SSP2-4.5", "SSP3-7.0"],
          "gcm": ["ACCESS-CM2", "EC-Earth3", "MPI-ESM1-2-HR"],
          "ds": ["RCM-A", "RCM-B"], "bc": ["QME", "QDM"],
          "hydro": [f"P{i:02}" for i in range(1, 6)], "member": ["r1", "r2"]}
CLOSURE_TOLERANCE = .05
# Percentage change removes each chain's baseline; absolute values keep baseline differences.
METRICS = [dict(id="annual_runoff", var="delta", name="Annual runoff · change", units="% change vs own 1990–2019 mean", threshold_id="runoff-minus20"),
           dict(id="annual_runoff_abs", var="value", name="Annual runoff · absolute", units="mm/yr (synthetic index)", threshold_id=None)]
YEARS = np.arange(1990, 2101)


def demo_cube():
    rng = np.random.default_rng(42)
    shape = tuple(map(len, LEVELS.values())) + (len(YEARS),)
    t = np.maximum(YEARS - 2019, 0) / 81
    values = np.empty(shape)
    for index in np.ndindex(shape[:-1]):
        s, g, d, b, h, m = index
        baseline = 100 * (1 + (h - 2)*.05 + (g-1)*.03)
        response = ([-12, -26, -43][s] + (g-1)*16 + (d-.5)*7 + (b-.5)*4 + (h-2)*3 + (g-1)*(h-2)*2) * t
        values[index] = baseline * (1 + (response + rng.normal(0, 7, len(YEARS)))/100)
    value = xr.DataArray(values, dims=list(LEVELS) + ["year"], coords={**LEVELS, "year": YEARS})
    return xr.Dataset({"value": value, "delta": normalise(value), "valid": value.notnull().all("year")})


def build(root):
    cube = demo_cube()
    fingerprint = cube.value.values.tobytes() + Path(__file__).read_bytes() + Path(__file__).with_name("analytics.py").read_bytes()
    build_id = "demo-" + hashlib.sha256(fingerprint).hexdigest()[:12]
    Path(root).mkdir(parents=True, exist_ok=True)
    destination = Path(root) / build_id
    if destination.exists():
        Path(root,"current.json").write_text(json.dumps({"build_id":build_id}))
        print(f"Reusing immutable release {build_id}")
        return
    target = Path(tempfile.mkdtemp(prefix=".building-", dir=root))
    cube.to_zarr(target / "metrics.zarr", mode="w", zarr_format=2)
    chain_rows = [dict(chain_id=f"demo-{i:04}", **dict(zip(LEVELS, levels)), provenance="Synthetic demonstration; no CMIP6 or Source outputs")
                  for i, levels in enumerate(itertools.product(*LEVELS.values()))]
    pd.DataFrame(chain_rows).to_parquet(target / "chains.parquet", index=False)
    tables = {name: [] for name in ["variance", "quantiles", "cascade", "exceedance", "futures"]}
    agreement = []
    for metric in METRICS:
        for scenario in ["all"] + LEVELS["ssp"]:
            delta = cube[metric["var"]] if scenario == "all" else cube[metric["var"]].sel(ssp=[scenario])
            for timescale in TIMESCALES:
                parts = partition(delta, timescale)
                series, response, _ = at_timescale(delta, timescale)
                for j, year in enumerate(parts.year.values):
                    tables["variance"].append(dict(metric=metric["id"], ssp=scenario, timescale=timescale, year=int(year), member_count=int(parts.member_count), **{"var_"+f: float(parts[f][j]) for f in COMPONENTS + EXTRA + ["total"]}))
                    q = np.quantile(series.sel(year=year).values, [.05,.1,.25,.5,.75,.9,.95])
                    tables["quantiles"].append(dict(metric=metric["id"], ssp=scenario, timescale=timescale, year=int(year), slice="all", n_chains=int(series.size/len(parts.year)), mean=float(response.sel(year=year).mean()), **dict(zip(["p05","p10","p25","p50","p75","p90","p95"], q))))
                for horizon in [2030,2050,2070,2090]:
                    tables["cascade"].extend(dict(metric=metric["id"],ssp=scenario,timescale=timescale,horizon=horizon,**r) for r in cascade(delta,horizon,timescale))
                for decade in range(2030,2100,10):
                    sub = series.sel(year=slice(decade,decade+9))
                    empirical = np.quantile(sub.values,[.05,.95])
                    half = 1.645*np.sqrt(float(parts.total.sel(year=slice(decade,decade+9)).mean()))
                    mismatch = abs(2*half - np.ptp(empirical))/max(float(np.ptp(empirical)),1e-9)
                    agreement.append(dict(metric=metric["id"],ssp=scenario,timescale=timescale,decade=decade,relative_width_difference=float(mismatch),flagged=bool(mismatch>.2)))
            if scenario != "all" and metric["threshold_id"]:  # breach rules are scored on annual values, whatever the timescale control says
                for decade in range(2030,2100,10):
                    annual = delta.sel(year=slice(decade,decade+9)).values.reshape(-1,10)
                    for rule in RULES:
                        tables["exceedance"].append(dict(metric=metric["id"],ssp=scenario,decade=decade,threshold_id="runoff-minus20",threshold=-20,rule=rule,**breaches(annual,-20,rule)))
    for s, scenario in enumerate(LEVELS["ssp"]):
        for g,gcm in enumerate(LEVELS["gcm"]):
            for horizon in [2030,2050,2070,2090]:
                dt=(1+s*.7)*(horizon-1990)/70
                dp=(-8-s*5+(g-1)*12)*(horizon-2019)/81
                tables["futures"].append(dict(ssp=scenario,gcm=gcm,horizon=horizon,dT=dt,dP=dp,temperature_class="Warmer" if dt<1.5 else "Hotter" if dt<2.5 else "Much hotter",rainfall_class="Much drier" if dp< -15 else "Drier" if dp< -5 else "Wetter" if dp>5 else "Little change"))
    for name, rows in tables.items():
        frame=pd.DataFrame(rows)
        frame["node"]="demo-catchment"
        if "metric" not in frame: frame["metric"]="annual_runoff"
        frame["build_id"]=build_id
        frame.to_parquet(target/f"{name}.parquet",index=False)
    # `total` is the empirical ensemble variance, so closure is a real check: the
    # components must explain it. Single years carry sampling noise, so test the bias.
    gaps = pd.DataFrame(tables["variance"]).groupby(["metric", "ssp", "timescale"]).apply(
        lambda g: abs(g["var_unattributed"].mean()) / g["var_total"].mean(), include_groups=False)
    closure = float(gaps.max())
    monotonic = all(all(r[a]<=r[b] for a,b in zip(["p05","p10","p25","p50","p75","p90"],["p10","p25","p50","p75","p90","p95"])) for r in tables["quantiles"])
    if closure>CLOSURE_TOLERANCE or not monotonic:
        raise ValueError(f"Product QA failed: unattributed variance {closure:.1%}, monotonic quantiles {monotonic}")
    metadata=dict(build_id=build_id,synthetic=True,node="demo-catchment",metric="annual_runoff",metrics=METRICS,baseline_spread_abs=dict(zip(["p10","p50","p90"],map(float,np.quantile(cube.value.sel(year=slice(1990,2019)).mean("year").values,[.1,.5,.9])))),baseline="1990–2019 calendar years (demo)",weighting="Equal GCM weights; fully balanced chain design",smoothing="Fourth-order polynomial, centred year",timescales=dict(default="decadal",decadal="Centred 10-year running mean (label year y = mean of y-5..y+4); every stage smoothed alike",annual="Single years"),exceedance_timescale="annual",n_chains=len(chain_rows),levels=LEVELS,qa=dict(unattributed_variance_fraction=closure,closure_tolerance=CLOSURE_TOLERANCE,member_count=len(LEVELS["member"]),monotonic_quantiles=monotonic,agreement=agreement,historical_skill="pending: observed data required",parameter_acceptance="pending: calibrated model required",bootstrap_stability="not implemented; no uncertainty intervals claimed"))
    (target/"metadata.json").write_text(json.dumps(metadata,indent=2))
    target.rename(destination)
    pending = Path(root,".current.tmp")
    pending.write_text(json.dumps({"build_id":build_id}))
    pending.replace(Path(root,"current.json"))
    print(f"Built {build_id}: {len(chain_rows)} synthetic chains → {destination}")

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",default="data")
    build(parser.parse_args().output)
