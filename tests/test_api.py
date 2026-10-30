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
