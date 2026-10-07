// The append-only translation write a frozen field's sidecar row rides — shared by `ctx.i18n.set` and rectify.
import type { ResourceModel } from "../core/app.ts";
import { stampTranslation } from "../features/tamper.ts";
import type { Db } from "./db.ts";
import { tamperEvidentOn } from "./schema.ts";

const sidecar = (m: ResourceModel) => `"${m.pgSchema}"."${m.name}_i18n"`;

/** Appends one translation of a frozen field. A concurrent writer that won the (locale, field) first leaves
 *  this insert matching nothing, which is refused rather than overwritten; a tamperEvident resource stamps the
 *  appended row into the translation chain. */
export async function appendTranslation(
  db: Db,
  model: ResourceModel,
  entityId: string,
  locale: string,
  field: string,
  value: string,
): Promise<void> {
  const chained = tamperEvidentOn(model.features);
  if (chained) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `tamper:${sidecar(model)}`,
    ]);
  }
  const inserted = (await db.query<{ chain_seq?: string }>(
    `INSERT INTO ${
      sidecar(model)
    } (entity_id, locale, field, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_id, locale, field) DO NOTHING
       RETURNING ${
      chained ? "chain_seq::text AS chain_seq" : "1 AS chain_seq"
    }`,
    [entityId, locale, field, value],
  )).rows[0];
  if (!inserted) {
    throw Object.assign(
      new Error(
        `${model.name}.${field}@${locale} was set concurrently and is set once — re-read it`,
      ),
      { kind: "conflict" as const },
    );
  }
  if (chained) await stampTranslation(db, model, String(inserted.chain_seq));
}
