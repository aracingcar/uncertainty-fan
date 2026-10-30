import test from 'node:test';
import assert from 'node:assert/strict';
import { staticProduct } from '../web/static-products.js';

const bundle = {
  metadata: {build_id: 'demo-test', synthetic: true},
  cubes: {annual_runoff: {years: [2030], values: [[1]]}, annual_runoff_abs: {years: [2030], values: [[100]]}},
  tables: {
    variance: [{ssp: 'SSP2-4.5', year: 2030, metric: 'annual_runoff'}, {ssp: 'all', year: 2030, metric: 'annual_runoff'}, {ssp: 'all', year: 2030, metric: 'annual_runoff_abs'}],
    cascade: [{ssp: 'all', horizon: 2030}, {ssp: 'all', horizon: 2050}],
    quantiles: [{ssp: 'SSP2-4.5', slice: 'all'}],
    chains: [{chain_id: 'demo-0000'}],
  },
};

test('metadata and chunk preserve API response shapes', () => {
  assert.equal(staticProduct(bundle, '/metadata'), bundle.metadata);
  assert.deepEqual(staticProduct(bundle, '/cube?node=demo&metric=annual_runoff&format=json'), {
    build_id: 'demo-test', data: bundle.cubes.annual_runoff,
  });
});
test('scenario, numeric horizon and slice filters match precomputed rows', () => {
  assert.deepEqual(staticProduct(bundle, '/variance?node=demo&metric=annual_runoff&ssp=all').data, [{ssp: 'all', year: 2030, metric: 'annual_runoff'}]);
  assert.equal(staticProduct(bundle, '/cube?node=demo&metric=annual_runoff_abs&format=json').data.values[0][0], 100);
  assert.equal(staticProduct(bundle, '/variance?node=demo&metric=annual_runoff_abs&ssp=all').data.length, 1);
  assert.equal(staticProduct(bundle, '/cascade?ssp=all&horizon=2050').data.length, 1);
  assert.equal(staticProduct(bundle, '/quantiles?ssp=SSP2-4.5&slice=all').data.length, 1);
  assert.equal(staticProduct(bundle, '/variance?ssp=missing').data.length, 0);
});
test('unknown routes fail visibly', () => {
  assert.throws(() => staticProduct(bundle, '/missing'), /Unknown static product/);
});
