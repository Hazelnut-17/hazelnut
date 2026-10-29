import type { Db } from "../data/db.ts";
import { tableOf } from "../core/app-define.ts";
import type { ResourceModel } from "../core/app.ts";
import { lifecycleMarkerColumns, tamperEvidentOn } from "../data/schema.ts";
import {
  LEGACY_TYPES,
  type StoredRow,
  storedRows,
  TYPED_TYPES,
  TYPED_VALUES,
} from "./tamper-stored.ts";
import { type Kms, unpackEnvelope } from "./encrypt-envelope.ts";
import type { Violation } from "../core/structural-violation.ts";

/** New appends use typed v3; authentic manifest-bearing v2 rows retain their original protocol. */
export const TAMPER_CHAIN_VERSION = 3;
export const TAMPER_CHAIN_PREFIX = `v${TAMPER_CHAIN_VERSION}:`;
export type TamperMac = (data: Uint8Array) => Promise<Uint8Array>;
type TamperMacs = (
  version: number,
  data: Uint8Array,
) => Promise<readonly Uint8Array[]>;
const macsByModel = new WeakMap<ResourceModel, TamperMacs>();
const te = new TextEncoder();
const CHAIN_COLS = new Set(["prev_hash", "row_hash", "chain_seq"]);
const MARKER_COLS = new Set([
  "superseded_by",
  "deleted_at",
  "version",
  "updated_at",
  "deleted_by_type",
  "deleted_by_id",
  "updated_by_type",
  "updated_by_id",
]);
/** Only enabled framework columns may transition outside the immutable payload.
 * Same-named authored columns remain ordinary signed business data. */
function markerColumns(
  model: ResourceModel,
  translation = false,
): ReadonlySet<string> {
  if (translation) return new Set();
  return new Set(lifecycleMarkerColumns(model.features));
}
/** Bind both current-first and historical MACs to resource AND format, never unsigned row data. */
export function bindTamperMacs(
  models: readonly ResourceModel[],
  kms: Kms,
): void {
  const eq = kms.equalityMacs?.bind(kms);
  if (!eq) return;
  for (const model of models) {
    if (!tamperEvidentOn(model.features)) continue;
    macsByModel.set(model, async (version, data) => {
      if (version !== 2 && version !== 3) {
        throw new Error("tamper/chain-version: unsupported format");
      }
      const purpose = `tamper:v${version}:${model.pgSchema}.${model.name}`;
      const tags = await eq(purpose, data);
      if (!tags[0]) {
        throw new Error(
          `tamper/key-source: KMS returned no MAC for purpose '${purpose}'`,
        );
      }
      return tags;
    });
  }
}
function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function equal(a: string, b: string): boolean {
  const x = te.encode(a), y = te.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return d === 0;
}
function canonField(value: unknown): string {
  if (value === null || value === undefined) return "\0NULL\0";
  if (value instanceof Uint8Array) return `b:${hexOf(value)}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (typeof value === "bigint") return `n:${value}`;
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
      ? Object.fromEntries(
        Object.keys(v).sort().map((
          k,
        ) => [k, stable((v as Record<string, unknown>)[k])]),
      )
      : v;
  return `j:${JSON.stringify(stable(value))}`;
}
function canonEncrypted(value: unknown): string {
  if (value == null) return canonField(value);
  const bytes = value instanceof Uint8Array
    ? value
    : Array.isArray(value)
    ? Uint8Array.from(value as number[])
    : typeof value === "string" && /^hex:(?:[a-f0-9]{2})*$/i.test(value)
    ? Uint8Array.from(value.slice(4).match(/../g) ?? [], (pair) =>
      parseInt(pair, 16))
    : null;
  if (!bytes) return canonField(value);
  try {
    const { iv, cipher } = unpackEnvelope(bytes);
    return `e:${hexOf(iv)}:${hexOf(cipher)}`;
  } catch {
    return `e:invalid:${hexOf(bytes)}`;
  }
}
export interface TamperRectification {
  readonly id: string;
  readonly rowHash: string;
  readonly markers: Readonly<Record<string, string>>;
}
interface Manifest {
  readonly codec?: "pg-typed-v1";
  readonly columns: readonly string[];
  readonly encrypted: readonly string[];
  readonly markers: Readonly<Record<string, string>>;
  readonly types?: Readonly<Record<string, string>>;
  readonly rectifies?: TamperRectification;
}
function fieldValue(
  row: StoredRow,
  column: string,
  version: number,
  encrypted = false,
): string {
  if (version !== 3) {
    return encrypted ? canonEncrypted(row[column]) : canonField(row[column]);
  }
  const values = row[TYPED_VALUES];
  if (!values || !Object.hasOwn(values, column)) {
    throw new Error(
      `tamper/codec: committed column '${column}' has no supported stored-value codec`,
    );
  }
  const value = values[column];
  return encrypted && value != null
    ? canonEncrypted(`hex:${value}`)
    : canonField(value);
}
function markersOf(
  row: StoredRow,
  version: number,
  columns: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    [...columns].filter((c) => Object.hasOwn(row, c)).sort().map((
      c,
    ) => [c, fieldValue(row, c, version)]),
  );
}
/** The old head's exact lifecycle image is authenticated by the correcting append, with its own digest. */
export async function tamperRectification(
  db: Db,
  model: ResourceModel,
  id: string,
): Promise<TamperRectification> {
  const row = (await storedRows(db, tableOf(model), "WHERE id = $1", [id]))[0]!;
  const parsed = typeof row.row_hash === "string"
    ? parseDigest(row.row_hash)
    : null;
  if (!parsed) {
    throw Object.assign(
      new Error(
        "tamper/chain-version: rectification requires a manifest-bearing chain; perform a reviewed history migration first",
      ),
      { kind: "conflict" },
    );
  }
  if (
    Object.keys(parsed.manifest.markers).sort().join("\0") !==
      Object.keys(
        markersOf(
          row,
          parsed.version,
          parsed.version === 2 ? MARKER_COLS : markerColumns(model),
        ),
      ).sort().join("\0")
  ) {
    throw Object.assign(
      new Error(
        "tamper/schema: lifecycle columns changed since this row was committed; perform a reviewed history migration before correction",
      ),
      { kind: "conflict" },
    );
  }
  return {
    id: String(row.id),
    rowHash: String(row.row_hash),
    markers: markersOf(
      row,
      parsed.version,
      parsed.version === 2 ? MARKER_COLS : markerColumns(model),
    ),
  };
}
function manifestFor(
  row: Record<string, unknown>,
  volatile: ReadonlySet<string>,
  encrypted: ReadonlySet<string>,
  rectifies: TamperRectification | undefined,
  version: number,
  markerCols: ReadonlySet<string>,
): Manifest {
  const columns = Object.keys(row).filter((c) =>
    !CHAIN_COLS.has(c) &&
    (!volatile.has(c) || encrypted.has(c) || markerCols.has(c))
  ).sort();
  const types = (row as StoredRow)[version === 3 ? TYPED_TYPES : LEGACY_TYPES];
  return {
    ...(version === 3 ? { codec: "pg-typed-v1" as const } : {}),
    columns,
    encrypted: columns.filter((c) => encrypted.has(c)),
    markers: markersOf(row, version, markerCols),
    ...(types
      ? {
        types: Object.fromEntries(
          columns.map((column) => [column, types[column]!]),
        ),
      }
      : {}),
    ...(rectifies ? { rectifies } : {}),
  };
}
const manifestBytes = (manifest: Manifest, version: number) =>
  te.encode(
    JSON.stringify([
      `hazelnut:tamper-manifest:v${version === 3 ? 3 : 2}`,
      manifest,
    ]),
  );
function linkBytes(
  row: Record<string, unknown>,
  prevHash: string | null,
  manifest: Manifest,
  version: number,
): Uint8Array {
  return te.encode(
    JSON.stringify([
      `hazelnut:tamper-row:v${version === 3 ? 3 : 2}`,
      manifest,
      String(row.chain_seq ?? ""),
      prevHash,
      manifest.columns.map((
        c,
      ) => [
        c,
        version === 3
          ? Object.hasOwn(manifest.markers, c)
            ? manifest.markers[c]
            : fieldValue(row, c, version, manifest.encrypted.includes(c))
          : manifest.markers[c] ??
            fieldValue(row, c, version, manifest.encrypted.includes(c)),
      ]),
    ]),
  );
}
function encodeManifest(manifest: Manifest): string {
  const bytes = te.encode(JSON.stringify(manifest));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary)
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function parseDigest(
  stored: string,
):
  | {
    version: number;
    manifest: Manifest;
    encoded: string;
    manifestTag: string;
    rowTag: string;
  }
  | null {
  const parts = /^v([23]):([A-Za-z0-9_-]+):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(
    stored,
  );
  if (!parts) return null;
  try {
    const version = Number(parts[1]);
    const json = atob(
      parts[2]!.replaceAll("-", "+").replaceAll("_", "/") +
        "===".slice((parts[2]!.length + 3) % 4),
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))),
    ) as Manifest;
    if (
      !manifest || !Array.isArray(manifest.columns) ||
      !Array.isArray(manifest.encrypted) || !manifest.markers ||
      manifest.columns.some((c) =>
        typeof c !== "string" || CHAIN_COLS.has(c)
      ) ||
      new Set(manifest.columns).size !== manifest.columns.length ||
      manifest.encrypted.some((c) =>
        typeof c !== "string" || !manifest.columns.includes(c)
      ) ||
      Object.entries(manifest.markers).some(([k, v]) =>
        !MARKER_COLS.has(k) || typeof v !== "string"
      )
    ) return null;
    if (
      version === 3 && (manifest.codec !== "pg-typed-v1" || !manifest.types ||
        Object.entries(manifest.markers).some(([key]) =>
          !manifest.columns.includes(key)
        ) ||
        manifest.columns.some((key) =>
          !Object.hasOwn(manifest.types!, key) ||
          typeof manifest.types![key] !== "string"
        ))
    ) return null;
    return {
      version,
      manifest,
      encoded: parts[2]!,
      manifestTag: parts[3]!,
      rowTag: parts[4]!,
    };
  } catch {
    return null;
  }
}
/** Hash the stored column manifest separately as well as inside the row link, so a missing committed
 * column can be diagnosed as schema drift only after authenticating that original manifest. */
export async function computeRowHash(
  row: Record<string, unknown>,
  prevHash: string | null,
  volatile: ReadonlySet<string> = new Set(),
  mac: TamperMac,
  encrypted: ReadonlySet<string> = new Set(),
  version = TAMPER_CHAIN_VERSION,
  rectifies?: TamperRectification,
  markerCols: ReadonlySet<string> = MARKER_COLS,
): Promise<string> {
  if (version === 3 && !(row as StoredRow)[TYPED_TYPES]) {
    throw new Error("tamper/codec: typed stored projection required");
  }
  const manifest = manifestFor(
    row,
    volatile,
    encrypted,
    rectifies,
    version,
    version === 3 ? markerCols : MARKER_COLS,
  );
  const m = hexOf(await mac(manifestBytes(manifest, version)));
  const h = hexOf(await mac(linkBytes(row, prevHash, manifest, version)));
  return `v${version}:${encodeManifest(manifest)}:${m}:${h}`;
}
function signer(model: ResourceModel): TamperMacs {
  const macs = macsByModel.get(model);
  if (!macs) {
    throw new Error(
      `tamper/key-source: resource '${model.name}' is tamperEvident but no HMAC signer is bound — supply defineConfig({ encryptionKey }) or a KMS with equalityMacs`,
    );
  }
  return macs;
}
/** Initial append stamp only; historical digests are never rewritten to conceal a marker transition. */
export async function stampTamperRow(
  db: Db,
  model: ResourceModel,
  id: string,
  rectifies?: TamperRectification,
): Promise<void> {
  if (!tamperEvidentOn(model.features)) return;
  const table = tableOf(model);
  const prevHash = (await db.query<{ row_hash: string | null }>(
    `SELECT row_hash FROM ${table} WHERE chain_seq < (SELECT chain_seq FROM ${table} WHERE id = $1) ORDER BY chain_seq DESC LIMIT 1`,
    [id],
  )).rows[0]?.row_hash ?? null;
  const row = (await storedRows(db, table, "WHERE id = $1", [id]))[0];
  if (!row) {
    throw new Error(
      `stampTamperRow: appended row '${id}' not found in '${model.name}'`,
    );
  }
  const macs = signer(model);
  const target = rectifies ? parseDigest(rectifies.rowHash) : null;
  if (
    rectifies && (!target || (target.version === 3 &&
      target.manifest.types?.superseded_by !== row[TYPED_TYPES]?.id))
  ) {
    throw new Error(
      "tamper/schema: correction pointer storage identity changed",
    );
  }
  const commitment = rectifies && target
    ? {
      ...rectifies,
      markers: {
        ...rectifies.markers,
        superseded_by: fieldValue(row, "id", target.version),
      },
    }
    : undefined;
  const rowHash = await computeRowHash(
    row,
    prevHash,
    new Set(model.tamperVolatileCols),
    async (data) => (await macs(TAMPER_CHAIN_VERSION, data))[0]!,
    new Set(model.encrypted),
    TAMPER_CHAIN_VERSION,
    commitment,
    markerColumns(model),
  );
  await db.query(
    `UPDATE ${table} SET prev_hash = $1, row_hash = $2 WHERE id = $3`,
    [prevHash, rowHash, id],
  );
}
const translationTable = (model: ResourceModel) =>
  `"${model.pgSchema}"."${model.name}_i18n"`;
export async function stampTranslation(
  db: Db,
  model: ResourceModel,
  chainSeq: string,
): Promise<void> {
  const table = translationTable(model);
  const prevHash = (await db.query<{ row_hash: string | null }>(
    `SELECT row_hash FROM ${table} WHERE chain_seq < $1 ORDER BY chain_seq DESC LIMIT 1`,
    [chainSeq],
  )).rows[0]?.row_hash ?? null;
  const row =
    (await storedRows(db, table, "WHERE chain_seq = $1", [chainSeq]))[0];
  const macs = signer(model);
  if (!row) {
    throw new Error(
      `stampTranslation: appended translation ${chainSeq} not found`,
    );
  }
  const rowHash = await computeRowHash(
    row,
    prevHash,
    new Set(),
    async (data) => (await macs(TAMPER_CHAIN_VERSION, data))[0]!,
    new Set(),
    TAMPER_CHAIN_VERSION,
    undefined,
    markerColumns(model, true),
  );
  await db.query(
    `UPDATE ${table} SET prev_hash = $1, row_hash = $2 WHERE chain_seq = $3`,
    [prevHash, rowHash, chainSeq],
  );
}
export interface ChainCheckpoint {
  readonly rootHash: string | null;
  readonly rowCount: number;
  readonly translationRootHash?: string | null;
  readonly translationRowCount?: number;
}
const violation = (
  model: ResourceModel,
  id: string,
  clause: string,
  message: string,
): Violation[] => [{ id, resource: model.name, clause, message }];
async function walkChain(
  model: ResourceModel,
  rows: readonly StoredRow[],
  translation = false,
): Promise<Violation[]> {
  let macs: TamperMacs;
  try {
    macs = signer(model);
  } catch (e) {
    return violation(model, "tamper/key-source", "", String(e));
  }
  let prevHash: string | null = null;
  const verified = new Map<
    string,
    { row: StoredRow; manifest: Manifest; version: number }
  >();
  const corrections = new Map<
    string,
    { id: string; commitment: TamperRectification }
  >();
  for (const row of rows) {
    const id = String(row.id ?? `${row.entity_id}:${row.field}@${row.locale}`);
    if (typeof row.row_hash !== "string") {
      return violation(
        model,
        "tamper/hash-chain",
        id,
        "a ledger row has no digest; missing hash is a business-integrity violation",
      );
    }
    const parsed = parseDigest(row.row_hash);
    if (!parsed) {
      return violation(
        model,
        /^v[23]:[^:]+:[^:]+:[^:]+$/.test(row.row_hash)
          ? "tamper/hash-chain"
          : "tamper/chain-version",
        id,
        "the digest is malformed or uses an earlier chain format; preserve the evidence and use a reviewed history migration with a new trusted anchor",
      );
    }
    const tags = await macs(
      parsed.version,
      manifestBytes(parsed.manifest, parsed.version),
    );
    if (!tags.some((tag) => equal(hexOf(tag), parsed.manifestTag))) {
      return violation(
        model,
        "tamper/hash-chain",
        id,
        "the signed column manifest was modified",
      );
    }
    // Some genuine legacy manifests never authenticated prototype-hit business values.
    // Accepting their old MAC cannot certify those values or safely authorize a correction.
    if (
      parsed.version === 2 &&
      parsed.manifest.columns.some((column) =>
        !Object.hasOwn(parsed.manifest.markers, column) &&
        column in Object.prototype
      )
    ) {
      return violation(
        model,
        "tamper/legacy-coverage",
        id,
        "legacy v2 did not authenticate a prototype-named column; preserve history and use a reviewed cutover with a new trusted anchor",
      );
    }
    const missing = parsed.manifest.columns.find((c) => !(c in row));
    if (missing) {
      return violation(
        model,
        "tamper/schema",
        id,
        `committed column '${missing}' is missing; verification requires the original schema or a reviewed history migration`,
      );
    }
    if (
      parsed.manifest.types &&
      parsed.manifest.columns.some((column) =>
        parsed.manifest.types![column] !==
          row[parsed.version === 3 ? TYPED_TYPES : LEGACY_TYPES]?.[column]
      )
    ) {
      return violation(
        model,
        "tamper/schema",
        id,
        "a committed column's storage type changed; verification requires the original schema or a reviewed history migration",
      );
    }
    if ((row.prev_hash ?? null) !== prevHash) {
      return violation(
        model,
        "tamper/hash-chain",
        id,
        "the stored predecessor link was modified or a committed row is missing",
      );
    }
    let candidates: readonly Uint8Array[];
    try {
      candidates = await macs(
        parsed.version,
        linkBytes(row, prevHash, parsed.manifest, parsed.version),
      );
    } catch (e) {
      return violation(model, "tamper/codec", id, String(e));
    }
    if (
      !candidates.some((tag, i) =>
        equal(hexOf(tag), parsed.rowTag) && tags[i] !== undefined &&
        equal(hexOf(tags[i]!), parsed.manifestTag)
      )
    ) {
      return violation(
        model,
        "tamper/hash-chain",
        id,
        "stored row_hash does not match the committed row bytes and chain position (business-integrity violation)",
      );
    }
    const correction = parsed.manifest.rectifies;
    if (correction) {
      const old = verified.get(correction.id);
      if (
        !old || old.row.row_hash !== correction.rowHash ||
        corrections.has(correction.id) ||
        !correction.markers ||
        Object.keys(correction.markers).sort().join("\0") !==
          Object.keys(old.manifest.markers).sort().join("\0") ||
        correction.markers.superseded_by !==
          fieldValue(row, "id", old.version) ||
        correction.markers.deleted_at === canonField(null)
      ) {
        return violation(
          model,
          "tamper/hash-chain",
          id,
          "the authenticated rectification back-pointer is not a valid earlier head commitment",
        );
      }
      corrections.set(correction.id, { id, commitment: correction });
    }
    verified.set(id, {
      row,
      manifest: parsed.manifest,
      version: parsed.version,
    });
    prevHash = row.row_hash;
  }
  for (const [id, { row, manifest, version }] of verified) {
    const expected = corrections.get(id)?.commitment.markers ??
      manifest.markers;
    if (
      Object.entries(expected).some(([column, value]) =>
        !(column in row) || fieldValue(row, column, version) !== value
      )
    ) {
      return violation(
        model,
        "tamper/hash-chain",
        id,
        "lifecycle/supersession markers differ from their authenticated append or correction commitment",
      );
    }
    if (
      [...(version === 2 ? MARKER_COLS : markerColumns(model, translation))]
        .some((column) =>
          column in row && !(column in manifest.markers) && row[column] != null
        )
    ) {
      return violation(
        model,
        "tamper/schema",
        id,
        "a newly introduced lifecycle authority is not covered by this historical row's manifest; use a reviewed history migration",
      );
    }
  }
  return [];
}
/** Verify all committed rows, then compare a checkpoint held OUTSIDE this database to detect tail loss.
 * Omitting the witness checks link integrity only and cannot prove that no suffix was removed. */
export async function verifyHashChain(
  db: Db,
  model: ResourceModel,
  expected?: ChainCheckpoint,
): Promise<Violation[]> {
  if (!tamperEvidentOn(model.features)) return [];
  // The exact-value projection aliases chain_seq::text back to chain_seq. Qualify the physical key so
  // ORDER BY uses bigint order (1,2,...,10), rather than the selected text alias (1,10,...,2).
  const rows = await storedRows(
    db,
    tableOf(model),
    `ORDER BY ${tableOf(model)}.chain_seq ASC`,
  );
  const base = await walkChain(model, rows);
  if (base.length) return base;
  if (
    expected && !checkpointMatches(rows, expected.rootHash, expected.rowCount)
  ) {
    return violation(
      model,
      "tamper/checkpoint",
      "",
      "the ledger root or row count differs from the trusted external checkpoint (tail deletion, truncation, or history replacement)",
    );
  }
  if (!model.i18n.length) return [];
  const translations = await storedRows(
    db,
    translationTable(model),
    `ORDER BY ${translationTable(model)}.chain_seq ASC`,
  );
  const side = await walkChain(model, translations, true);
  if (side.length) return side;
  if (
    expected && expected.translationRowCount !== undefined &&
    !checkpointMatches(
      translations,
      expected.translationRootHash ?? null,
      expected.translationRowCount,
    )
  ) {
    return violation(
      model,
      "tamper/checkpoint",
      "",
      "the translation ledger differs from its trusted external checkpoint",
    );
  }
  return [];
}
function checkpointMatches(
  rows: readonly Record<string, unknown>[],
  rootHash: string | null,
  count: number,
): boolean {
  return Number.isSafeInteger(count) && count >= 0 && count <= rows.length &&
    (count === 0 ? rootHash === null : rows[count - 1]?.row_hash === rootHash);
}
/** Capture a root and length for an external trusted witness; storing it beside the ledger is no witness. */
export async function chainCheckpoint(
  db: Db,
  model: ResourceModel,
): Promise<ChainCheckpoint> {
  const root = async (table: string) => {
    const rows = (await db.query<{ row_hash: string | null; n: string }>(
      `SELECT row_hash, count(*) OVER ()::text AS n FROM ${table} ORDER BY chain_seq DESC LIMIT 1`,
    )).rows;
    return {
      rootHash: rows[0]?.row_hash ?? null,
      rowCount: Number(rows[0]?.n ?? 0),
    };
  };
  const base = await root(tableOf(model));
  if (!model.i18n.length) return base;
  const side = await root(translationTable(model));
  return {
    ...base,
    translationRootHash: side.rootHash,
    translationRowCount: side.rowCount,
  };
}
// ── AnchorSink Port (the external-witness seam) ──────────────────────────────────────────────────
// The chain catches a single-row rewrite; anchoring a periodic root hash to an external witness (BYO Port,
// mirrors setTracer's noop default) also catches a full-chain rewrite by a DBA who recomputes it downstream.

/** An anchoring receipt — opaque proof the root hash was witnessed. */
export interface AnchorReceipt {
  readonly sink: string; // which sink produced it ("local-file" / "noop")
  readonly rootHash: string;
  readonly at: string; // ISO instant the anchor was recorded
  readonly ref?: string; // sink-specific locator, opaque to the framework
}

/** The external-witness Port: anchor a chain root hash to an append-only witness, returning a receipt. A real
 *  adapter writes to a transparency log / chain; the floor sinks below are the zero-cost in-process defaults. */
export interface AnchorSink {
  anchor(rootHash: string): Promise<AnchorReceipt>;
}

/**
 * The zero-cost default sink (mirrors setTracer's noop): records nothing external, just stamps a receipt.
 * An app that wires no AnchorSink still gets single-rewrite detection from the chain alone.
 */
export const noopAnchorSink: AnchorSink = {
  anchor(rootHash: string): Promise<AnchorReceipt> {
    return Promise.resolve({
      sink: "noop",
      rootHash,
      at: new Date().toISOString(),
    });
  },
};

/**
 * A local-file floor sink — appends each `{rootHash, at}` to a newline-delimited file. Still inside the trust
 * domain (a DBA with disk access can rewrite it), so it is a floor, not the real external witness.
 */
export function fileAnchorSink(path: string): AnchorSink {
  return {
    async anchor(rootHash: string): Promise<AnchorReceipt> {
      const at = new Date().toISOString();
      await Deno.writeTextFile(path, JSON.stringify({ rootHash, at }) + "\n", {
        append: true,
      });
      return { sink: "local-file", rootHash, at, ref: path };
    },
  };
}

/**
 * The chain root = the head row's `row_hash` (by `chain_seq` commit order, not uuidv7 id order). Anchoring
 * this one value witnesses the whole chain transitively. `null` for an empty ledger.
 */
export async function chainRoot(
  db: Db,
  model: ResourceModel,
): Promise<string | null> {
  if (!tamperEvidentOn(model.features)) return null;
  return (await chainCheckpoint(db, model)).rootHash;
}
