import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { longestRun, breachCount } from '../web/stats.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/breach_rules.json', import.meta.url)));

test('breach rules match the shared fixture', () => {
  for (const c of cases) {
    const values = c.dry.map(d => (d ? -30 : 0));
    assert.equal(longestRun(c.dry.map(Boolean)), c.longest_run);
    assert.equal(breachCount(values, -20, 'dry_years_per_decade', c.n), Number(c.dry_years_per_decade));
    assert.equal(breachCount(values, -20, 'consecutive_run', c.n), Number(c.consecutive_run));
  }
});

test('unknown rule is rejected', () => assert.throws(() => breachCount([0], -20, 'persistent'), /Unknown/));

import { runningMean } from '../web/stats.js';

test('running mean labels windows y-5..y+4 and drops incomplete ones', () => {
  const years = Array.from({length: 20}, (_, i) => 2000 + i);
  const out = runningMean(years, years.map((_, i) => i));
  assert.deepEqual([out.years[0], out.years.at(-1), out.years.length], [2005, 2015, 11]);
  assert.deepEqual([out.values[0], out.values.at(-1)], [4.5, 14.5]);
});

import { fanRows, selectChains, breachGrid, headlineShares, describeFan, toCsv, esc, quantile } from '../web/stats.js';

const chains = [
  {ssp: 'A', gcm: 'g1', hydro: 'p1'}, {ssp: 'A', gcm: 'g1', hydro: 'p2'},
  {ssp: 'A', gcm: 'g2', hydro: 'p1'}, {ssp: 'B', gcm: 'g1', hydro: 'p1'},
];

test('quantile interpolates', () => assert.equal(quantile([0, 10], .25), 2.5));

test('selectChains separates scenario from slicers', () => {
  assert.deepEqual(selectChains(chains, 'A', {gcm: 'all', hydro: 'all'}), {full: [0, 1, 2], active: [0, 1, 2]});
  assert.deepEqual(selectChains(chains, 'A', {gcm: 'g1', hydro: 'p1'}), {full: [0, 1, 2], active: [0]});
  assert.deepEqual(selectChains(chains, 'all', {gcm: 'g1'}).active, [0, 1, 3]);
  assert.deepEqual(selectChains(chains, 'A', {gcm: 'zz'}).active, []);
});

test('fanRows reports percentiles and the mean of the selected chains only', () => {
  const view = {years: [2019, 2020, 2021], values: [[0, 10, 20], [0, 30, 40], [0, 50, 60]]};
  const all = fanRows(view, [0, 1, 2]), some = fanRows(view, [0, 1]);
  assert.deepEqual(all.map(r => r.year), [2020, 2021]);
  assert.equal(all[0].p50, 30);
  assert.equal(all[0].mean, 30);
  assert.equal(some[0].mean, 20);      // filtered mean differs from the full mean
  assert.equal(some[1].mean, 30);
});

test('breachGrid counts chain-years or chains and keeps empty cells explicit', () => {
  const years = Array.from({length: 10}, (_, i) => 2030 + i);
  const cube = {years, values: [years.map(() => -30), years.map((_, i) => i < 2 ? -30 : 0), years.map(() => 0), years.map(() => 0)]};
  const annual = breachGrid(cube, chains, [0, 1, 2, 3], ['A', 'B'], [2030], -20, 'annual');
  assert.deepEqual(annual.map(c => [c.scenario, c.count, c.denominator]), [['A', 12, 30], ['B', 0, 10]]);
  const run = breachGrid(cube, chains, [0, 1, 2, 3], ['A'], [2030], -20, 'consecutive_run', 2);
  assert.deepEqual([run[0].count, run[0].denominator, run[0].n_chains], [2, 3, 3]);
  const none = breachGrid(cube, chains, [3], ['A'], [2030], -20, 'annual');
  assert.deepEqual([none[0].share, none[0].n_chains], [null, 0]);
});

test('headlineShares normalises by attributed components and uses the decadal label', () => {
  const keys = ['ssp', 'gcm', 'ds', 'bc', 'hydro', 'interaction', 'internal'];
  const row = year => ({year, ssp: 1, gcm: 2, ds: 3, bc: 4, hydro: 5, interaction: 6, internal: 9});
  const s = headlineShares([row(2054), row(2055), row(2056)], keys, 2050, 'decadal');
  assert.equal(Math.round(s.climate), 33);      // 10 of 30
  assert.equal(Math.round(s.internal), 30);
  assert.ok(Math.abs(s.climate + s.hydro + s.internal + s.interaction - 100) < 1e-9);
  assert.equal(headlineShares([row(2055)], keys, 2050, 'decadal').climate, 100 * 10 / 30);
  assert.deepEqual(headlineShares([row(2054)], keys, 2050, 'decadal'), {climate: 0, hydro: 0, internal: 0, interaction: 0});  // no row for this horizon
});

test('describeFan averages annual rows over the decade and picks one decadal row', () => {
  const rows = [2054, 2055, 2056].map((year, i) => ({year, p10: -i, p50: i, p90: 10 + i}));
  assert.deepEqual(describeFan(rows, 2050, 'decadal'), {median: 1, p10: -1, p90: 11});
  assert.equal(describeFan(rows, 2090, 'decadal'), null);
});

test('toCsv quotes awkward cells and writes preamble comments', () => {
  const text = toCsv(['a', 'b'], [['x,y', 'say "hi"'], [null, 3]], ['build demo']);
  assert.equal(text, '# build demo\na,b\n"x,y","say ""hi"""\n,3');
});

test('esc escapes markup', () => assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;'));
