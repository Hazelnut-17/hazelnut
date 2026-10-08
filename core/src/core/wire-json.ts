// The JSON wire form of a native value: bytes become Postgres's `bytea` text output.

const HEX = Array.from(
  { length: 256 },
  (_, i) => i.toString(16).padStart(2, "0"),
);

/**
 * `value` as it crosses a JSON wire. A `Uint8Array` becomes `\x` + hex — the `bytea` text output, which a write
 * reads back with the column's text input — where `JSON.stringify` would emit an object of index keys. Arrays
 * and plain objects are walked; every other value is returned as it is.
 */
export function wireJson<V>(value: V): V {
  return walk(value, new Map()) as V;
}

/** Copy-on-write: a value holding no bytes is returned as the same reference. A shared object maps once; a
 *  cycle is left in place for `JSON.stringify` to refuse as it always has. */
function walk(v: unknown, done: Map<object, unknown>): unknown {
  if (v instanceof Uint8Array) {
    let out = "\\x";
    for (const b of v) out += HEX[b];
    return out;
  }
  if (v === null || typeof v !== "object") return v;
  if (done.has(v)) return done.get(v);
  done.set(v, v);
  let out: unknown = v;
  if (Array.isArray(v)) {
    let copy: unknown[] | undefined;
    for (let i = 0; i < v.length; i++) {
      const x = walk(v[i], done);
      if (x !== v[i]) (copy ??= v.slice())[i] = x;
    }
    out = copy ?? v;
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    let copy: Record<string, unknown> | undefined;
    for (const [k, x] of Object.entries(v)) {
      const y = walk(x, done);
      if (y !== x) (copy ??= { ...v })[k] = y;
    }
    out = copy ?? v;
  }
  done.set(v, out);
  return out;
}
