"""Read-only API over one immutable product release, pinned at process startup."""
import io
import json
import os
from pathlib import Path
import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import xarray as xr
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .analytics import RULES, RULE_ALIASES, TIMESCALES

ROOT = Path(__file__).resolve().parent.parent


def create_app(data_dir=None):
    data_dir = Path(data_dir or os.environ.get("HYDROFAN_DATA", ROOT / "data"))
    pointer = json.loads((data_dir / "current.json").read_text())
    release = data_dir / pointer["build_id"]
    metadata = json.loads((release / "metadata.json").read_text())
    build_id = metadata["build_id"]
    cube = xr.open_zarr(release / "metrics.zarr").load()
    app = FastAPI(title="Hydroclimate Uncertainty Fan", version="0.1.0")

    @app.middleware("http")
    async def cache(request, call_next):
        response = await call_next(request)
        response.headers["X-Build-ID"] = build_id
        # URLs do not contain build_id, so require revalidation after releases.
        response.headers["Cache-Control"] = "no-cache"
        return response

    specs = {m["id"]: m for m in metadata["metrics"]}

    def check(node, metric):
        if node != metadata["node"] or metric not in specs:
            raise HTTPException(404, "Unknown node or metric")

    def known(timescale):
        if timescale not in TIMESCALES: raise HTTPException(422,f"timescale must be one of {TIMESCALES}")
        return timescale

    def rows(table, filters=None):
        filters = filters or {}
        query = "SELECT * FROM read_parquet(?)"
        params = [str(release / f"{table}.parquet")]
        if filters:
            query += " WHERE " + " AND ".join(f'"{key}" = ?' for key in filters)
            params.extend(filters.values())
        with duckdb.connect() as db:
            cursor = db.execute(query, params)
            names = [col[0] for col in cursor.description]
            return [dict(zip(names, row)) for row in cursor.fetchall()]

    def envelope(data):
        return dict(build_id=build_id, data=data)

    @app.get("/metadata")
    def meta():
        return metadata

    @app.get("/nodes")
    def nodes():
        return envelope([dict(id=metadata["node"], name="Demonstration catchment")])

    @app.get("/metrics")
    def metrics():
        return envelope(metadata["metrics"])

    @app.get("/chains")
    def chains():
        return envelope(rows("chains"))

    @app.get("/variance")
    def variance(node: str, metric: str, ssp: str="all", timescale: str="decadal"):
        check(node,metric)
        return envelope(rows("variance",dict(metric=metric,ssp=ssp,timescale=known(timescale))))

    @app.get("/cascade")
    def cascade(node: str, metric: str, horizon: int=2050, ssp: str="all", timescale: str="decadal"):
        check(node,metric)
        return envelope(rows("cascade",dict(metric=metric,horizon=horizon,ssp=ssp,timescale=known(timescale))))

    @app.get("/quantiles")
    def quantiles(node: str, metric: str, ssp: str="all", slice: str="all", timescale: str="decadal"):
        check(node,metric)
        return envelope(rows("quantiles",dict(metric=metric,ssp=ssp,slice=slice,timescale=known(timescale))))

    @app.get("/exceedance")
    def exceedance(node: str, metric: str, threshold_id: str="runoff-minus20", rule: str="annual"):
        check(node,metric)
        rule=RULE_ALIASES.get(rule,rule)
        if rule not in RULES: raise HTTPException(422,f"rule must be one of {RULES}")
        return envelope(rows("exceedance",dict(metric=metric,threshold_id=threshold_id,rule=rule)))

    @app.get("/futures")
    def futures(horizon: int=2050, ssp: str="SSP2-4.5"):
        return envelope(rows("futures",dict(horizon=horizon,ssp=ssp)))

    @app.get("/cube")
    def chunk(node: str, metric: str, format: str=Query("arrow",pattern="^(arrow|json)$")):
        check(node,metric)
        # Same product chunk and chain order for JSON prototype and Arrow clients.
        variable = specs[metric]["var"]
        matrix = cube[variable].values.reshape(-1, len(cube.year))
        if format == "json":
            return envelope(dict(years=cube.year.values.tolist(),values=np.round(matrix,5).tolist()))
        batch = pa.table({"chain_id":[r["chain_id"] for r in rows("chains")],
                          variable:pa.array(matrix.tolist(), type=pa.list_(pa.float32()))})
        batch = batch.replace_schema_metadata({b"build_id":build_id.encode(), b"years":json.dumps(cube.year.values.tolist()).encode()})
        sink=io.BytesIO()
        with ipc.new_stream(sink,batch.schema) as writer:
            writer.write_table(batch)
        return Response(sink.getvalue(),media_type="application/vnd.apache.arrow.stream")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "web" / "index.html")

    app.mount("/static", StaticFiles(directory=ROOT/"web"), name="static")
    return app
