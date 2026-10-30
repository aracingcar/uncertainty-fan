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
