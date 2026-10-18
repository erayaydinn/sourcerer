const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

// Replaces ${VAR} and ${VAR:-default} in every string of a parsed YAML value.
// Unset and empty count the same. Names of unset variables without a default
// are pushed to `missing` as "NAME (at path.to.key)".
export function interpolate(value, env, missing, where = []) {
  if (typeof value === 'string') {
    return value.replace(VAR, (match, name, fallback) => {
      if (env[name]) return env[name];
      if (fallback !== undefined) return fallback;
      missing.push(`${name} (at ${where.join('.')})`);
      return match;
    });
  }
  if (Array.isArray(value)) return value.map((item, i) => interpolate(item, env, missing, [...where, i]));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env, missing, [...where, key])]));
  }
  return value;
}
