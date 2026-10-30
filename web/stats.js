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

export const quantile = (sorted, p) => {
  const i = (sorted.length - 1) * p, l = Math.floor(i);
  return sorted[l] + (sorted[Math.ceil(i)] - sorted[l]) * (i - l);
};
export const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

/** Per-year ensemble percentiles and the mean of the chains in `ids`; `view` is {years, values[chain][year]}. */
export function fanRows(view, ids, fromYear = 2020) {
  const rows = [];
  view.years.forEach((year, j) => {
    if (year < fromYear) return;
    const a = ids.map(i => view.values[i][j]).sort((x, y) => x - y);
    rows.push({year, p05: quantile(a, .05), p10: quantile(a, .1), p50: quantile(a, .5), p90: quantile(a, .9), p95: quantile(a, .95), mean: mean(a)});
  });
  return rows;
}

/** Chains in the selected scenario (`full`) and those that also match every fixed factor (`active`). */
export function selectChains(chains, scenario, fixed) {
  const full = chains.flatMap((c, i) => scenario === 'all' || c.ssp === scenario ? [i] : []);
  const active = full.filter(i => Object.entries(fixed).every(([f, v]) => v === 'all' || chains[i][f] === v));
  return {full, active};
}

/** Breach share per scenario × decade for the active chains; mirrors hydrofan.analytics.breaches. */
export function breachGrid(cube, chains, active, scenarios, decades, threshold, rule, n = 3) {
  const cells = [];
  for (const scenario of scenarios) {
    const ids = active.filter(i => chains[i].ssp === scenario);
    for (const decade of decades) {
      if (!ids.length) { cells.push({scenario, decade, count: 0, denominator: 0, share: null, n_chains: 0}); continue; }
      const js = cube.years.flatMap((y, j) => y >= decade && y < decade + 10 ? [j] : []);
      let count = 0;
      for (const i of ids) count += breachCount(js.map(j => cube.values[i][j]), threshold, rule, n);
      const denominator = ids.length * (rule === 'annual' ? js.length : 1);
      cells.push({scenario, decade, count, denominator, share: count / denominator, n_chains: ids.length});
    }
  }
  return cells;
}

/** Rows of the variance table that describe the decade `horizon`…`horizon`+9 (decadal labels are window means). */
export const horizonRows = (rows, horizon, timescale) =>
  rows.filter(r => timescale === 'annual' ? r.year >= horizon && r.year < horizon + 10 : r.year === horizon + 5);

const CLIMATE = ['ssp', 'gcm', 'ds', 'bc'];
/** Percent shares of attributed variance for climate / hydro / internal / interaction at one horizon. */
export function headlineShares(varianceRows, keys, horizon, timescale) {
  const rows = horizonRows(varianceRows, horizon, timescale);
  if (!rows.length) return {climate: 0, hydro: 0, internal: 0, interaction: 0};
  const total = mean(rows.map(r => keys.reduce((s, k) => s + r[k], 0)));
  const pct = k => total ? 100 * mean(rows.map(r => r[k])) / total : 0;
  return {climate: CLIMATE.reduce((s, k) => s + pct(k), 0), hydro: pct('hydro'), internal: pct('internal'), interaction: pct('interaction')};
}

/** Plain-language reading of the fan at one horizon: {median, p10, p90} averaged over the horizon's rows. */
export function describeFan(rows, horizon, timescale) {
  const r = horizonRows(rows, horizon, timescale);
  return r.length ? {median: mean(r.map(x => x.p50)), p10: mean(r.map(x => x.p10)), p90: mean(r.map(x => x.p90))} : null;
}

/** CSV text with optional `#` preamble lines; cells are quoted when they contain commas, quotes or newlines. */
export function toCsv(columns, rows, preamble = []) {
  const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [...preamble.map(p => `# ${p}`), columns.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\n');
}

/** Escape text for use in HTML. */
export const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
