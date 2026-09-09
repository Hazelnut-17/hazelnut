import type { ResourceModel } from "../core/app.ts";
import type { VersionDecl } from "../core/versions.ts";
import { all } from "../core/where.ts";
import type { Db } from "../data/db.ts";
import { list, type ReadCtx, type RowPolicy } from "../data/repo.ts";
import type { Kms } from "../features/encrypt.ts";
import {
  assertFiniteEgress,
  egress,
  servedColumnsOf,
} from "../features/redact.ts";
import { applyVersion } from "./version-runtime.ts";

/** The response row is MINTED from the projection, so a column the DDL grew cannot reach the wire. */
export function projectWire(
  cols: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(cols.map((k) => [k, row[k]]));
}

/** Reads the pre-projection row: the minted one carries every key by construction. */
export function wireMissing(
  cols: readonly string[],
  rows: readonly unknown[],
): string | null {
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    for (const k of cols) {
      if (!(k in (row as Record<string, unknown>))) return k;
    }
  }
  return null;
}

export function missingProjectedColumn(
  resource: string,
  column: string,
): Error {
  return new Error(
    `wire/response-shape: '${column}' is projected by ${resource} but absent from the row — the physical table no longer carries it (DB drift); fix the drift, never ship a response missing a promised field`,
  );
}

const listPolicy = <Row>(
  m: ResourceModel,
): RowPolicy<Row> =>
  (m.rowPolicy as RowPolicy<Row> | null) ?? (() => all<Row>());

/**
 * The HTTP list/find wire mint (project → finite-number wall → egress → version).
 * SSE row push calls the list branch so the two doors cannot drift.
 */
export function mintReadWire(
  m: ResourceModel,
  verb: "list" | "find",
  rows: readonly Record<string, unknown>[],
  request: Request,
  versions: readonly VersionDecl[],
): Record<string, unknown> | Record<string, unknown>[] {
  const cols = servedColumnsOf(m, verb);
  const missing = wireMissing(cols, rows);
  if (missing !== null) throw missingProjectedColumn(m.name, missing);
  const pin = { req: { raw: request } };
  if (verb === "find") {
    const out = egress(
      m,
      assertFiniteEgress(m, projectWire(cols, rows[0]!)),
    );
    return applyVersion(versions, m, pin, out);
  }
  const out = egress(
    m,
    assertFiniteEgress(m, rows.map((r) => projectWire(cols, r))),
  );
  return out.map((r) => applyVersion(versions, m, pin, r));
}

/** The live list the GET door would return with no `?where=` — rowPolicy, projection, redact, version. */
export async function listedVisibleRows(
  db: Db,
  m: ResourceModel,
  ctx: ReadCtx,
  kms: Kms | undefined,
  request: Request,
  versions: readonly VersionDecl[],
): Promise<Record<string, unknown>[]> {
  const rows = await list<Record<string, unknown>>(
    db,
    m,
    ctx,
    listPolicy(m),
    all<Record<string, unknown>>(),
    kms,
  );
  return mintReadWire(m, "list", rows, request, versions) as Record<
    string,
    unknown
  >[];
}
