/** Read the exported products using the same response shapes as the local API. */
export function staticProduct(bundle, path) {
  const url = new URL(path, 'https://local.invalid');
  if (url.pathname === '/metadata') return bundle.metadata;
  const name = url.pathname.slice(1);
  if (name === 'cube') return {build_id: bundle.metadata.build_id, data: bundle.cube};
  if (!(name in bundle.tables)) throw new Error(`Unknown static product: ${name}`);
  const filters = [...url.searchParams].filter(([key]) => !['node', 'metric', 'format'].includes(key));
  return {
    build_id: bundle.metadata.build_id,
    data: bundle.tables[name].filter(row => filters.every(([key, value]) => String(row[key]) === value)),
  };
}
