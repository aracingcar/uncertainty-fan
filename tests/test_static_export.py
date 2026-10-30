import json
from pathlib import Path
import numpy as np
import pytest
from hydrofan.build import build
from hydrofan.export_static import export_static


def test_static_site_export(tmp_path):
    data = tmp_path / 'products'
    site = tmp_path / 'site'
    build(data)
    export_static(data, site)
    bundle = json.loads((site / 'data/demo.json').read_text())
    html = (site / 'index.html').read_text()
    assert 'data-static="true"' in html
    assert '/static/' not in html
    assert 'href="/chains"' not in html
    assert (site / 'static-products.js').is_file()
    assert (site / '.nojekyll').exists()
    assert len(bundle['cubes']['annual_runoff']['values']) == bundle['metadata']['n_chains'] == 360
    assert len(bundle['cubes']['annual_runoff']['years']) == 111
    assert len(bundle['tables']['variance']) == 2 * 4 * (102 + 111)  # two metrics; decadal 1995-2096 + annual
    assert len(bundle['tables']['cascade']) == 2 * 4 * 2 * 4 * 6
    assert all(row['build_id'] == bundle['metadata']['build_id'] for row in bundle['tables']['variance'])
    assert (site / 'stats.js').exists()
    rules = {row['rule'] for row in bundle['tables']['exceedance']}
    assert {row['metric'] for row in bundle['tables']['exceedance']} == {'annual_runoff'}  # thresholds are % change only
    assert {m['id'] for m in bundle['metadata']['metrics']} == {'annual_runoff', 'annual_runoff_abs'}
    assert rules == {'annual', 'dry_years_per_decade', 'consecutive_run', 'decadal_mean'}
    chain_list = json.loads((site / 'data/chains.json').read_text())
    assert chain_list['data'] == bundle['tables']['chains']
    # Confirm public deployment cannot accidentally export a real-data release.
    release = data / bundle['metadata']['build_id'] / 'metadata.json'
    metadata = json.loads(release.read_text())
    metadata['synthetic'] = False
    release.write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match='synthetic'):
        export_static(data, tmp_path / 'rejected')

