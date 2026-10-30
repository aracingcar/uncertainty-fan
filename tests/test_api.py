import pyarrow.ipc as ipc
import pyarrow as pa
import pytest
from fastapi.testclient import TestClient
from hydrofan.build import build
from hydrofan.api import create_app

@pytest.fixture(scope='module')
def client(tmp_path_factory):
    root=tmp_path_factory.mktemp('products')
    build(root)
    return TestClient(create_app(root))


def test_catalogue_and_products(client):
    metadata=client.get('/metadata').json()
    assert metadata['synthetic']
    for path in ['/nodes','/metrics','/chains','/variance?node=demo-catchment&metric=annual_runoff','/quantiles?node=demo-catchment&metric=annual_runoff','/cascade?node=demo-catchment&metric=annual_runoff','/exceedance?node=demo-catchment&metric=annual_runoff','/futures']:
        response=client.get(path)
        assert response.status_code==200
        assert response.json()['build_id']==metadata['build_id']
        assert response.json()['data']
    assert client.get('/').status_code==200
    assert client.get('/variance?node=bad&metric=annual_runoff').status_code==404
    assert client.post('/chains').status_code==405


def test_arrow_and_json_agree(client):
    url='/cube?node=demo-catchment&metric=annual_runoff'
    response=client.get(url)
    table=ipc.open_stream(pa.py_buffer(response.content)).read_all()
    json_data=client.get(url+'&format=json').json()
    assert len(table)==len(json_data['data']['values'])==360
    assert table.schema.metadata[b'build_id'].decode()==json_data['build_id']
    assert len(table['delta'][0].as_py())==111


def test_query_value_cannot_change_sql(client):
    response=client.get('/quantiles',params=dict(node='demo-catchment',metric='annual_runoff',ssp="' OR 1=1 --"))
    assert response.status_code==200
    assert response.json()['data']==[]


def test_timescale_selects_distinct_products(client):
    base=dict(node='demo-catchment',metric='annual_runoff',ssp='all')
    dec=client.get('/variance',params=base).json()['data']
    ann=client.get('/variance',params={**base,'timescale':'annual'}).json()['data']
    assert {r['timescale'] for r in dec}=={'decadal'} and len(dec)==102
    assert {r['timescale'] for r in ann}=={'annual'} and len(ann)==111
    assert dec[0]['var_internal_fast']<ann[0]['var_internal_fast']
    cas=lambda ts:client.get('/cascade',params={**base,'horizon':2050,'timescale':ts}).json()['data']
    assert len(cas('decadal'))==len(cas('annual'))==6
    assert client.get('/quantiles',params={**base,'timescale':'weekly'}).status_code==422


def test_absolute_metric_is_separate_product(client):
    ids=[m['id'] for m in client.get('/metrics').json()['data']]
    assert ids==['annual_runoff','annual_runoff_abs']
    q=lambda m:client.get('/quantiles',params=dict(node='demo-catchment',metric=m,ssp='all')).json()['data']
    pct,absolute=q('annual_runoff'),q('annual_runoff_abs')
    assert len(pct)==len(absolute)==102
    assert abs(pct[50]['p50'])<60 and absolute[50]['p50']>60  # % change vs index around 100
    cube=client.get('/cube',params=dict(node='demo-catchment',metric='annual_runoff_abs',format='json')).json()['data']
    assert 50<cube['values'][0][0]<200
    assert client.get('/exceedance',params=dict(node='demo-catchment',metric='annual_runoff_abs')).json()['data']==[]
    assert client.get('/variance',params=dict(node='demo-catchment',metric='nope')).status_code==404


def test_sensitivity_and_bootstrap_products(client):
    p=dict(node='demo-catchment',metric='annual_runoff',ssp='all',horizon=2050)
    sens=client.get('/sensitivity',params=p).json()['data']
    assert {r['estimator'] for r in sens}=={'poly2','poly3','poly4','poly6','lowess','member_mean'}
    for r in sens:
        assert abs(r['share_climate']+r['share_hydro']+r['share_internal']+r['share_interaction']-100)<1e-6
    assert max(r['share_internal'] for r in sens)-min(r['share_internal'] for r in sens)>.5
    boot=client.get('/bootstrap',params=p).json()['data']
    assert len(boot)==1 and boot[0]['draws']>=1 and boot[0]['climate_p05']<=boot[0]['climate_p50']<=boot[0]['climate_p95']
    meta=client.get('/metadata').json()
    assert meta['qa']['bootstrap_stability']['resampled'].startswith('GCMs')
    assert 'internal' in meta['qa']['estimator_sensitivity']['max_share_range_points']
