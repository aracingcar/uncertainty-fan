"""Export the synthetic dashboard for GitHub Pages, with no Python server at runtime."""
import argparse
import json
import shutil
from pathlib import Path
import numpy as np
import pandas as pd
import xarray as xr


def export_static(data_dir='data', output='_site'):
    data_dir, output = Path(data_dir), Path(output)
    build_id = json.loads((data_dir / 'current.json').read_text())['build_id']
    release = data_dir / build_id
    metadata = json.loads((release / 'metadata.json').read_text())
    # This public exporter deliberately supports only the synthetic demo release.
    if metadata.get('synthetic') is not True:
        raise ValueError('Public demo exporter requires an explicitly synthetic release')
    tables = {
        name: pd.read_parquet(release / f'{name}.parquet').to_dict(orient='records')
        for name in ['chains', 'variance', 'quantiles', 'cascade', 'exceedance', 'futures']
    }
    with xr.open_zarr(release / 'metrics.zarr') as cube:
        cubes = {m['id']: dict(years=cube.year.values.tolist(),
                               values=np.round(cube[m['var']].values.reshape(-1, len(cube.year)), 5).tolist())
                 for m in metadata['metrics']}
    bundle = dict(metadata=metadata, tables=tables, cubes=cubes)
    assets = Path(__file__).resolve().parent.parent / 'web'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'data').mkdir(exist_ok=True)
    for filename in ['app.js', 'static-products.js', 'stats.js', 'style.css']:
        shutil.copy2(assets / filename, output / filename)
    html = (assets / 'index.html').read_text()
    html = html.replace('<html lang="en">', '<html lang="en" data-static="true">')
    html = html.replace('/static/', './').replace('href="/chains"', 'href="./data/chains.json"')
    (output / 'index.html').write_text(html)
    (output / '.nojekyll').touch()
    (output / 'data' / 'demo.json').write_text(json.dumps(bundle, separators=(',', ':'), allow_nan=False))
    (output / 'data' / 'chains.json').write_text(json.dumps(dict(build_id=build_id, data=tables['chains']), indent=2))
    print(f'Exported synthetic release {build_id} to {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default='data')
    parser.add_argument('--output', default='_site')
    args = parser.parse_args()
    export_static(args.data_dir, args.output)
