/** Breach-rule helpers shared with hydrofan/analytics.py (see tests/fixtures/breach_rules.json). */
export function longestRun(dry) {
  let best = 0, run = 0;
  for (const d of dry) { run = d ? run + 1 : 0; if (run > best) best = run; }
  return best;
}

/** Number of chains (or chain-years for 'annual') in breach for one decade of one chain's values. */
export function breachCount(values, threshold, rule, n = 3) {
  const dry = values.map(v => v < threshold);
  switch (rule) {
    case 'annual': return dry.filter(Boolean).length;
    case 'dry_years_per_decade': return Number(dry.filter(Boolean).length >= n);
    case 'consecutive_run': return Number(longestRun(dry) >= n);
    case 'decadal_mean': return Number(values.reduce((s, v) => s + v, 0) / values.length < threshold);
    default: throw new Error(`Unknown breach rule: ${rule}`);
  }
}

/**
 * Centred 10-year running mean matching hydrofan.analytics.decadal_mean: the value labelled
 * year y is the mean of y-5 … y+4; years without a full window are dropped.
 */
export function runningMean(years, values, window = 10) {
  const before = Math.floor(window / 2), after = window - before - 1;
  const out = {years: [], values: []};
  for (let k = before; k + after < values.length; k++) {
    let sum = 0;
    for (let m = k - before; m <= k + after; m++) sum += values[m];
    out.years.push(years[k]);
    out.values.push(sum / window);
  }
  return out;
}
