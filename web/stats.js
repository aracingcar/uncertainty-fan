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
