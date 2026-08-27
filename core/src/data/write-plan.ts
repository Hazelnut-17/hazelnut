/** The declarative write plan: per-feature write-path
 *  contributions (`WRITE_CARDS`) and the per-verb weave order (`*_WEAVE`) — the single source of
 *  step order and presence; step gating stays in the impls. Imports types only (no import cycle). */
import type { ResourceModel } from "../core/app-types.ts";
import type { Features } from "../core/faces.ts";

// ── vocabulary ────────────────────────────────────────────────────────────────────────────────────

/** Classification of every write step. Weave order is the per-verb list below; phases mark the slot a step
 * fills without reordering it — a verb may interleave phases.
 */
export const WRITE_PHASES = [
  "transform", // mutate the value/patch map before SQL assembly (encrypt, password-hash)
  "serialize", // advisory locks taken before the guarded/locking work they serialize (tamper append, tree reparent, rollup edges)
  "guard", // refuse an illegal write before any mutation (frozen fields, tree cycle, cross-scope parent, stale CAS precheck)
  "columns", // contribute INSERT entries / UPDATE SET fragments (id, user cols, onRow, scope, sequence, timestamps, version)
  "where", // contribute WHERE conjuncts gating which row the write may touch (scope, live-guard, CAS, rowPolicy, purge)
  "preImage", // capture the before image / rollup targets before the row write
  "cascade", // pre-write sweeps over other rows this write must settle first (onDelete sweeps, tree children)
  "rowWrite", // the INSERT / UPDATE / DELETE itself — framework core, exactly one per verb
  "maintain", // same-tx maintenance after the row write (rollups, closure, vector stamp, read-model enqueue)
  "stamp", // the tamper hash-chain stamp — last write to this row
  "record", // the _audit append
] as const;
export type WritePhase = (typeof WRITE_PHASES)[number];

export const WRITE_VERBS = ["create", "update", "remove", "restore"] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

/** Model-marker pseudo-features: write-relevant declarations that are not `Features` flags (they are
 *  schema field markers, relations, or derived indexes on the model). Carded exactly like features. */
export const MARKER_CARD_KEYS = [
  "encrypted", // bytea-envelope fields (04-features.md §encrypted)
  "passwords", // password() fields — salted slow-KDF hash at rest
  "files", // file() fields — off-box storage keys (GC on hard delete)
  "i18n", // translatable() fields — sidecar table, separate write surface
  "sensitive", // PII redaction — read/log-side only
  "child", // parent/parentFk relation (02-dsl.md §owns)
  "references", // by-id FK columns — plain user columns on the write path
  "onDeleteSweeps", // reverse-reference sweeps this resource must run on its delete (03-api-shape.md §onDelete)
  "rollupChild", // rollupTargets — this resource's writes maintain a parent's aggregate (03-api-shape.md §8)
  "readModel", // readModelSinks — outbox-fenced re-projection enqueue on every write
  "rowPolicy", // declared rowPolicy — write-side WHERE conjunct
  "tamperEvident", // immutable:{tamperEvident} sub-option — append lock + hash-chain stamp
] as const;
export type MarkerCardKey = (typeof MARKER_CARD_KEYS)[number];
export type WriteCardKey = keyof Required<Features> | MarkerCardKey;

// ── card shape ────────────────────────────────────────────────────────────────────────────────────

/** An inlined contribution: executed inside a core step (it needs that step's SQL statement or its
 *  RETURNING result), declared here so the weave stays the single source of presence. */
export interface InlineContribution {
  readonly in: string; // the core step id it rides (must exist in that verb's weave — self-checked)
  readonly note: string; // what it contributes there
}

/** A card's contribution to one verb: named steps (each must appear in that verb's weave), inlined
 *  contributions, or the explicit literal `"abstain"` — never an implicit absence. */
export type CardVerbSlot =
  | "abstain"
  | {
    readonly steps?: readonly string[];
    readonly inline?: readonly InlineContribution[];
  };

/** The narrow model view the volatile-column derivation reads (computable mid-boot, before the full
 *  ResourceModel literal exists). */
export type VolatileView = Pick<
  ResourceModel,
  "encrypted" | "vector" | "rollupOwnCols" | "features"
>;

export interface WriteCard {
  /** Is the feature declared on this resource? Self-check axis only — execution gating stays inside
   *  the step impls (verbatim), so the plan cannot drift from the code's own conditions. */
  readonly on: (m: ResourceModel) => boolean;
  /** Total over verbs (TS-enforced): contribute or explicitly abstain. */
  readonly verbs: Readonly<Record<WriteVerb, CardVerbSlot>>;
  /** Columns the framework rewrites outside the stamped write path — the tamperVolatileCols source.
   *  Absent = contributes none. */
  readonly volatileCols?: (m: VolatileView) => readonly string[];
  /** update()'s writable-surface modifiers (folded by `updateWritableOf`): lifecycle columns this
   *  feature makes caller-editable, or columns it removes from the patch surface. */
  readonly updateWritable?: {
    readonly allows?: (m: ResourceModel) => readonly string[];
    readonly denies?: (m: ResourceModel) => readonly string[];
  };
}

// ── the cards ─────────────────────────────────────────────────────────────────────────────────────

/** Pure twin of schema-normalize.ts `tamperEvidentOn` — re-stated here (types-only module) and
 *  equivalence-asserted by the write-plan self-check test, so the two cannot drift silently. */
const tamperEvidentPredicate = (f: Features): boolean =>
  typeof f.immutable === "object" && f.immutable !== null &&
  f.immutable.tamperEvident === true;

const ABSTAIN_ALL: Readonly<Record<WriteVerb, CardVerbSlot>> = {
  create: "abstain",
  update: "abstain",
  remove: "abstain",
  restore: "abstain",
};

/** The feature-flag cards — `Record<keyof Required<Features>, …>` makes a new `Features` key a
 *  compile error here until it is carded (the anti-silent-absence tooth). */
const FEATURE_CARDS: Readonly<Record<keyof Required<Features>, WriteCard>> = {
  softDelete: {
    on: (m) => Boolean(m.features.softDelete),
    verbs: {
      create: "abstain", // deleted_at is born NULL via DDL — nothing to write
      update: { steps: ["update.whereLive"] },
      remove: {
        steps: ["remove.whereLiveGuard"],
        inline: [{
          in: "remove.execDelete",
          note: "soft path: UPDATE deleted_at = now() instead of DELETE",
        }],
      },
      restore: {
        steps: ["restore.softDeleteOnlyGuard", "restore.whereTombstoned"],
        inline: [{
          in: "restore.execRestore",
          note: "UPDATE deleted_at = NULL — the inverse stamp",
        }],
      },
    },
  },
  timestamps: {
    on: (m) => Boolean(m.features.timestamps),
    verbs: {
      create: {
        inline: [{
          in: "create.insert",
          note:
            "created_at/updated_at land via DDL DEFAULT now() — omitted from the INSERT by design",
        }],
      },
      update: { steps: ["update.stampUpdatedAt"] },
      remove: "abstain", // a delete (soft or hard) does not re-stamp updated_at
      restore: "abstain",
    },
  },
  audit: {
    on: (m) => Boolean(m.features.audit),
    verbs: {
      create: { steps: ["create.audit"] },
      update: {
        steps: ["update.audit"],
        inline: [{
          in: "update.captureBeforeImage",
          note: "the {from,to} diff needs the whole prior image",
        }],
      },
      remove: { steps: ["remove.captureBeforeImage", "remove.audit"] },
      restore: { steps: ["restore.audit"] },
    },
  },
  onRow: {
    on: (m) => Boolean(m.features.onRow),
    verbs: {
      create: { steps: ["create.createdByColumns"] },
      update: { steps: ["update.updatedByColumns"] },
      remove: {
        inline: [{
          in: "remove.execDelete",
          note:
            "deleted_by_type/_id stamped on the soft-delete UPDATE (iff softDelete)",
        }],
      },
      restore: { steps: ["restore.clearDeletedByColumns"] },
    },
  },
  sequence: {
    on: (m) => Boolean(m.features.sequence),
    verbs: {
      create: { steps: ["create.allocateSequence"] },
      update: "abstain", // a sequence value is allocated once, never re-written
      remove: "abstain", // gap-free means gaps from deletes are accepted, never re-compacted
      restore: "abstain",
    },
  },
  immutable: {
    on: (m) =>
      m.features.immutable !== undefined && m.features.immutable !== false,
    verbs: {
      create: "abstain", // immutability constrains later writes; birth is unconstrained
      update: {
        steps: ["update.wholeImmutableGuard", "update.frozenFieldsGuard"],
      },
      remove: { steps: ["remove.wholeImmutableGuard"] },
      restore: "abstain", // whole-immutable ⇒ softDelete-less delete removed ⇒ nothing to restore
    },
    // rectifiable (04-features.md §immutable, GDPR Art. 16) stamps superseded_by + deleted_at after the
    // tamper stamp — both are lifecycle markers, tamper-volatile: hashing them would false-flag every rectified head.
    volatileCols: (
      m,
    ) => (typeof m.features.immutable === "object" &&
        m.features.immutable !== null &&
        (m.features.immutable as { rectifiable?: boolean }).rectifiable === true
      ? ["superseded_by", "deleted_at"]
      : []),
  },
  tree: {
    on: (m) => Boolean(m.features.tree),
    verbs: {
      create: { steps: ["create.assertTreeParentInScope"] },
      update: {
        steps: [
          "update.lockTreeForReparent",
          "update.assertReparentInScope",
          "update.cycleGuard",
        ],
      },
      remove: { steps: ["remove.sweepTreeChildren"] },
      restore: "abstain", // restoring a node re-enters it with its stored parent_id; closure rows survived the soft delete
    },
    // tree's self-FK is often minted, not a schema field — still a caller-writable adjacency column.
    updateWritable: {
      allows: (m) => {
        const t = m.features.tree;
        if (!t) return [];
        return [
          typeof t === "object" && t.parentField ? t.parentField : "parent_id",
        ];
      },
    },
  },
  treeClosure: {
    on: (m) => Boolean(m.features.tree) && Boolean(m.features.treeClosure),
    verbs: {
      create: { steps: ["create.lockTreeForCreate", "create.addToClosure"] },
      update: { steps: ["update.rebuildClosure"] },
      remove: "abstain", // hard delete: closure rows fall via FK cascade; soft delete: rows stay (node revivable)
      restore: "abstain",
    },
  },
  versioning: {
    on: (m) => Boolean(m.features.versioning),
    verbs: {
      create: {
        inline: [{
          in: "create.insert",
          note: "version lands via DDL DEFAULT 1",
        }],
      },
      update: { steps: ["update.bumpVersion", "update.whereVersionCas"] },
      remove: { steps: ["remove.whereVersionCas", "remove.stalePrecheck"] },
      restore: "abstain", // restore is not CAS-gated (no expectedVersion surface)
    },
  },
  expiry: {
    on: (m) => Boolean(m.features.expiry),
    verbs: {
      create: "abstain", // expires_at is caller-supplied (a plain optional column at birth)
      update: {
        inline: [{
          in: "update.userSets",
          note: "expires_at is caller-editable — expiry-extend revives",
        }],
      },
      remove: { steps: ["remove.wherePurgeGuard"] },
      restore: "abstain", // remove's contribution is a WHERE guard, not a stamp — a restore has none to undo, and a revived-but-expired row stays invisible behind the read stack's own expiry conjunct
    },
    updateWritable: {
      allows: (m) => (m.features.expiry ? ["expires_at"] : []),
    },
  },
  temporal: {
    on: (m) => Boolean(m.features.temporal),
    verbs: {
      create: {
        inline: [{
          in: "create.insert",
          note: "valid_from lands via DDL DEFAULT now()",
        }],
      },
      update: {
        inline: [{
          in: "update.userSets",
          note:
            "valid_to is caller-editable — temporal-correction closes the old row",
        }],
      },
      remove: "abstain",
      restore: "abstain",
    },
    updateWritable: {
      allows: (m) => (m.features.temporal ? ["valid_to"] : []),
    },
  },
  scope: {
    on: (m) => Boolean(m.features.scope),
    verbs: {
      create: { steps: ["create.scopeKeyColumn"] },
      update: { steps: ["update.whereScope"] },
      remove: { steps: ["remove.whereScope"] },
      restore: { steps: ["restore.whereScope"] },
    },
  },
  searchable: {
    on: (m) => Boolean(m.features.searchable) || m.searchable.length > 0,
    verbs: ABSTAIN_ALL, // tsvector is a GENERATED column + GIN index — zero repo write steps
  },
  singleton: {
    on: (m) => Boolean(m.features.singleton),
    verbs: {
      create: {
        inline: [
          {
            in: "create.mintId",
            note:
              "GLOBAL singleton mints the fixed sentinel id; scoped singleton mints a normal uuidv7",
          },
          {
            in: "create.insert",
            note:
              "conflict-tolerant first-seed: ON CONFLICT target = (id) global / (scope_key)+partial-predicate scoped",
          },
        ],
      },
      update: "abstain",
      remove: "abstain",
      restore: "abstain",
    },
  },
  transitions: {
    on: (m) => Object.keys(m.transitions).length > 0,
    verbs: {
      create: {
        inline: [{
          in: "create.userColumns",
          note:
            "status omitted-when-absent → DDL DEFAULT mints the declared initial state",
        }],
      },
      update: {
        inline: [{
          in: "update.userSets",
          note: "status is transition-only — skipped from every raw patch",
        }],
      },
      remove: "abstain",
      restore: "abstain",
    },
    updateWritable: {
      denies: (m) => (Object.keys(m.transitions).length > 0 ? ["status"] : []),
    },
  },
  rollups: {
    // the owner side: this resource carries maintained aggregate columns; its children's writes
    // maintain them (the rollupChild card below). The owner's own verbs contribute nothing.
    on: (m) => m.rollupOwnCols.length > 0,
    verbs: ABSTAIN_ALL,
    volatileCols: (m) => m.rollupOwnCols, // rewritten by child writes without a re-stamp
  },
  vector: {
    on: (m) => m.vector !== null,
    verbs: {
      create: { steps: ["create.stampVectorAndEnqueue"] },
      update: { steps: ["update.restampVectorOnSourceChange"] },
      remove: "abstain", // the row is gone/tombstoned — nothing to re-embed; the read-model drop is readModel's
      restore: "abstain", // vector + shadow cols survived the soft delete unchanged
    },
    volatileCols: (m) =>
      m.vector
        ? [
          m.vector.field,
          `${m.vector.field}_embedded_at`,
          `${m.vector.field}_source_hash`,
          `${m.vector.field}_model`,
        ]
        : [],
  },
};

/** The marker cards (schema-field / relation / derived-index write contributors). */
const MARKER_CARDS: Readonly<Record<MarkerCardKey, WriteCard>> = {
  encrypted: {
    on: (m) => m.encrypted.length > 0,
    verbs: {
      create: { steps: ["create.encrypt"] },
      update: { steps: ["update.encrypt"] },
      remove: "abstain",
      restore: "abstain",
    },
    volatileCols: (m) => m.encrypted, // envelopes re-wrapped on DEK rotation without a re-stamp
  },
  passwords: {
    on: (m) => m.passwords.length > 0,
    verbs: {
      create: { steps: ["create.hashPasswords"] },
      update: { steps: ["update.hashPasswords"] },
      remove: "abstain",
      restore: "abstain",
    },
  },
  files: {
    on: (m) => m.files.length > 0,
    verbs: {
      create: "abstain", // file keys are plain user columns at birth
 update: "abstain", // key rewrite leaves the old blob to the app (no repo GC on update — )
      remove: {
        inline: [{
          in: "remove.execDelete",
          note:
            "hard path RETURNING file cols → same-tx _file_gc enqueue (no-orphan chokepoint)",
        }],
      },
      restore: "abstain", // the GC rides the HARD delete only, and a hard-deleted row cannot be restored — a soft delete leaves every blob in place, so there is nothing to re-fetch
    },
  },
  i18n: {
    on: (m) => m.i18n.length > 0,
    verbs: ABSTAIN_ALL, // translations ride the <r>_i18n sidecar surface, not these verbs
  },
  sensitive: {
    on: (m) => m.sensitive.length > 0,
    verbs: ABSTAIN_ALL, // redaction is read/log-side (response projection, audit diff, OTel)
  },
  child: {
    on: (m) => m.parentFk !== null,
    verbs: {
      create: {
        steps: ["create.parentFkColumn", "create.assertParentInScope"],
      },
      update: "abstain", // parentFk is not in model.columns — a raw patch cannot re-parent an owned child
      remove: "abstain", // the child side of onDelete is the parent's sweep, not this verb's
      restore: "abstain",
    },
  },
  references: {
    on: (m) => Object.keys(m.references).length > 0,
    verbs: ABSTAIN_ALL, // by-id FK columns are plain user columns; integrity is DDL's
  },
  onDeleteSweeps: {
    on: (m) => m.onDeleteSweeps.length > 0,
    verbs: {
      create: "abstain",
      update: "abstain",
      remove: { steps: ["remove.sweepOnDelete"] },
      restore: "abstain", // restoring a parent does not un-sweep children (cascade is one-way)
    },
  },
  rollupChild: {
    on: (m) => m.rollupTargets.length > 0,
    verbs: {
      create: {
        steps: ["create.lockRollupEdges", "create.maintainParentRollups"],
      },
      update: {
        steps: ["update.lockRollupEdges", "update.maintainRollups"],
        inline: [{
          in: "update.captureBeforeImage",
          note:
            "a field-bearing rollup whose field the patch touches forces the pre-image read",
        }],
      },
      remove: {
        steps: [
          "remove.lockRollupEdges",
          "remove.captureRollupTargets",
          "remove.maintainRollups",
        ],
      },
      restore: {
        steps: [
          "restore.lockRollupEdges",
          "restore.captureRollupTargets",
          "restore.maintainRollups",
        ],
      },
    },
  },
  readModel: {
    on: (m) => m.readModelSinks.length > 0,
    verbs: {
      create: { steps: ["create.enqueueReadModelUpsert"] },
      update: { steps: ["update.enqueueReadModelUpsert"] },
      remove: { steps: ["remove.enqueueReadModelDrop"] },
      // the INVERSE of remove's drop: without it a live row stays absent from the projection forever,
      // with nothing pending and nothing dead-lettered — a silent permanent skew, not eventual staleness.
      restore: { steps: ["restore.enqueueReadModelUpsert"] },
    },
  },
  rowPolicy: {
    on: (m) => m.hasRowPolicy,
    verbs: {
      create: "abstain", // create has no existing row to gate; policy runs at the op layer
      update: { steps: ["update.whereRowPolicy"] },
      remove: { steps: ["remove.whereRowPolicy"] },
      restore: { steps: ["restore.whereRowPolicy"] },
    },
  },
  tamperEvident: {
    on: (m) => tamperEvidentPredicate(m.features),
    verbs: {
      create: { steps: ["create.tamperAppendLock", "create.stampTamperRow"] },
      update: "abstain", // tamperEvident ⇒ whole-resource immutable ⇒ update is removed by construction
      remove: "abstain", // same — delete is removed; the chain is append-only
      restore: "abstain",
    },
  },
};

export const WRITE_CARDS: Readonly<Record<WriteCardKey, WriteCard>> = {
  ...FEATURE_CARDS,
  ...MARKER_CARDS,
};

// ── the weaves (exact per-verb order — the constraints that lived in comments are `after`/`why` data) ──

/** One step in a verb's weave. `card` names the contributing card (`"_core"` = the verb skeleton);
 *  `after` lists step ids that MUST precede it (self-check-enforced). */
export interface WeaveEntry {
  readonly card: WriteCardKey | "_core";
  readonly step: string;
  readonly phase: WritePhase;
  readonly after?: readonly string[];
  readonly why?: string;
}

export const CREATE_WEAVE: readonly WeaveEntry[] = [
  {
    card: "_core",
    step: "create.mintId",
    phase: "columns",
    why:
      "uuidv7 app-mint (index locality) / singleton sentinel / DB-allocated omit (uuidv4, serial); runs FIRST so create.encrypt can seal its position AAD to the settled id",
  },
  {
    card: "encrypted",
    step: "create.encrypt",
    phase: "transform",
    after: ["create.mintId"],
    why:
      "ciphertext-at-rest before the INSERT, AAD-bound to `schema.table.field.rowId` (a relocated envelope fails the GCM tag)",
  },
  {
    card: "passwords",
    step: "create.hashPasswords",
    phase: "transform",
    why: "salted slow-KDF hash-at-rest before the INSERT — never plaintext",
  },
  {
    card: "tamperEvident",
    step: "create.tamperAppendLock",
    phase: "serialize",
    why:
      "per-table advisory xact lock BEFORE the INSERT so id-order == stamp-order — a concurrent append cannot stamp against a not-yet-committed predecessor and false-flag verifyHashChain",
  },
  {
    card: "_core",
    step: "create.userColumns",
    phase: "columns",
    why:
      "absent value on a DDL-defaulted column is OMITTED so the DEFAULT mints it (03-api-shape.md §4); explicit null writes verbatim",
  },
  {
    card: "_core",
    step: "create.lifecycleColumns",
    phase: "columns",
    after: ["create.userColumns"],
    why:
      "the caller-suppliable lifecycle window (temporal valid_from/valid_to · expiry expires_at, createSuppliableOf) threads verbatim when supplied; absent → the DDL default mints it (the Insertable face admitted these but the runtime dropped them)",
  },
  { card: "child", step: "create.parentFkColumn", phase: "columns" },
  {
    card: "treeClosure",
    step: "create.lockTreeForCreate",
    phase: "serialize",
    why:
      "the SAME xact lock move/setParent hold — create-under-P and a concurrent move of P are exclusive, else the child links to stale ancestry forever; ahead of the rollup edge lock because `update` takes the pair in that order (an inverted pair is an AB-BA deadlock)",
  },
  {
    card: "rollupChild",
    step: "create.lockRollupEdges",
    phase: "serialize",
    why:
      "the up-edge advisory lock BEFORE any row lock: create.assertParentsLive takes FOR SHARE on the parent and create.maintainParentRollups upgrades it, so two concurrent creates under one soft-deletable parent deadlock (40P01) without it",
  },
  {
    card: "child",
    step: "create.assertParentInScope",
    phase: "guard",
    after: ["create.parentFkColumn"],
    why:
      "the bare FK references id alone — validate the parent row is in ctx.scope BEFORE the insert",
  },
  {
    card: "tree",
    step: "create.assertTreeParentInScope",
    phase: "guard",
    why: "the tree self-FK cross-scope guard",
  },
  {
    card: "_core",
    step: "create.assertParentsLive",
    phase: "guard",
    after: ["create.parentFkColumn"],
    why:
      "REL-01 sibling: refuse a child whose FK points at a soft-deleted (tombstoned) parent — a FOR SHARE liveness probe serialized against the remover's FOR UPDATE",
  },
  { card: "onRow", step: "create.createdByColumns", phase: "columns" },
  { card: "scope", step: "create.scopeKeyColumn", phase: "columns" },
  {
    card: "sequence",
    step: "create.allocateSequence",
    phase: "columns",
    why:
      "gap-free locked-row allocation must ride THIS op tx before the INSERT; native-sequence is omitted so the DDL nextval DEFAULT allocates",
  },
  {
    card: "_core",
    step: "create.insert",
    phase: "rowWrite",
    after: [
      "create.mintId",
      "create.userColumns",
      "create.lifecycleColumns",
      "create.allocateSequence",
      "create.tamperAppendLock",
      "create.assertParentInScope",
      "create.assertTreeParentInScope",
    ],
    why:
      "a conflict-tolerant singleton first-seed that inserted 0 rows HALTS here — the winning peer's seed already ran the side effects below",
  },
  {
    card: "rollupChild",
    step: "create.maintainParentRollups",
    phase: "maintain",
    after: ["create.insert"],
    why:
      "count/sum atomic delta; avg/min/max recompute — same tx (03-api-shape.md §8)",
  },
  {
    card: "treeClosure",
    step: "create.addToClosure",
    phase: "maintain",
    after: ["create.lockTreeForCreate", "create.insert"],
    why: "closure lock strictly precedes the closure write",
  },
  {
    card: "vector",
    step: "create.stampVectorAndEnqueue",
    phase: "maintain",
    after: ["create.insert"],
    why:
      "stamp source_hash shadows + enqueue the re-embed in the SAME tx — an embed is an external call, never in-tx compute",
  },
  {
    card: "readModel",
    step: "create.enqueueReadModelUpsert",
    phase: "maintain",
    after: ["create.insert"],
    why: "outbox-fenced re-projection enqueued in the SAME tx",
  },
  {
    card: "tamperEvident",
    step: "create.stampTamperRow",
    phase: "stamp",
    after: ["create.insert", "create.stampVectorAndEnqueue"],
    why:
      "runs LAST among this row's writes so it hashes the SETTLED stored bytes (the same bytes verifyHashChain re-reads)",
  },
  {
    card: "audit",
    step: "create.audit",
    phase: "record",
    after: ["create.stampTamperRow"],
    why:
      "create has no prior state — every set column audits as from:null→to:value",
  },
];

export const UPDATE_WEAVE: readonly WeaveEntry[] = [
  {
    card: "immutable",
    step: "update.wholeImmutableGuard",
    phase: "guard",
    why:
      "whole-resource immutable: update is removed by construction — no write, no audit",
  },
  {
    card: "immutable",
    step: "update.frozenFieldsGuard",
    phase: "guard",
    why:
      "field-level set-once: a patch touching a frozen field conflicts BEFORE any write (and before encrypting)",
  },
  {
    card: "tree",
    step: "update.lockTreeForReparent",
    phase: "serialize",
    why:
      "serialize the check-then-act BEFORE wouldCycle, held to commit — two concurrent re-parents that TOGETHER form a cycle cannot both pass",
  },
  {
    card: "tree",
    step: "update.assertReparentInScope",
    phase: "guard",
    after: ["update.lockTreeForReparent"],
    why: "a re-parent via update must stay in-scope",
  },
  {
    card: "tree",
    step: "update.cycleGuard",
    phase: "guard",
    after: ["update.lockTreeForReparent"],
    why: "tree/no-cycle: refuse a looping parent_id before any write",
  },
  {
    card: "encrypted",
    step: "update.encrypt",
    phase: "transform",
    why:
      "encrypt a patched encrypted field BEFORE the SET clause — else plaintext lands in the ciphertext column",
  },
  { card: "passwords", step: "update.hashPasswords", phase: "transform" },
  {
    card: "_core",
    step: "update.userSets",
    phase: "columns",
    why:
      "patch → SET fragments; updateWritableOf(model) folds the card allows (valid_to/expires_at) and denies (status is transition-only)",
  },
  {
    card: "timestamps",
    step: "update.stampUpdatedAt",
    phase: "columns",
    why:
      "gated on the `updated` half — a write-once {created:true} fact has no updated_at",
  },
  { card: "onRow", step: "update.updatedByColumns", phase: "columns" },
  {
    card: "versioning",
    step: "update.bumpVersion",
    phase: "columns",
    why: "version = version + 1 on every applied write",
  },
  {
    card: "_core",
    step: "update.emptyPatchGuard",
    phase: "guard",
    after: ["update.userSets"],
    why:
      "zero SET fragments ⇒ nothing to write — return before locks/pre-reads",
  },
  {
    card: "rollupChild",
    step: "update.lockRollupEdges",
    phase: "serialize",
    after: ["update.emptyPatchGuard"],
    why:
      "take the rollup-edge advisory lock BEFORE the first row lock (the before-image FOR UPDATE) so update ∥ remove(parent) cascade cannot deadlock",
  },
  {
    card: "_core",
    step: "update.captureBeforeImage",
    phase: "preImage",
    after: ["update.lockRollupEdges"],
    why:
      "one read serves BOTH the audit diff and a field-bearing rollup delta (rollupNeedsBeforeImage)",
  },
  { card: "_core", step: "update.whereId", phase: "where" },
  { card: "scope", step: "update.whereScope", phase: "where" },
  {
    card: "softDelete",
    step: "update.whereLive",
    phase: "where",
    why: "a soft-deleted row is not updatable",
  },
  {
    card: "versioning",
    step: "update.whereVersionCas",
    phase: "where",
    why: "optimistic-lock CAS: WHERE version = :expected",
  },
  {
    card: "rowPolicy",
    step: "update.whereRowPolicy",
    phase: "where",
    why:
      "a row this actor's rowPolicy hides matches 0 rows — never a cross-owner mutation; appended after every framework conjunct",
  },
  {
    card: "_core",
    step: "update.execUpdate",
    phase: "rowWrite",
    after: [
      "update.userSets",
      "update.whereId",
      "update.whereScope",
      "update.whereLive",
      "update.whereVersionCas",
      "update.whereRowPolicy",
      "update.captureBeforeImage",
    ],
  },
  {
    card: "treeClosure",
    step: "update.rebuildClosure",
    phase: "maintain",
    after: ["update.execUpdate"],
    why:
      "the SET wrote the new adjacency; the <r>_tree links to the OLD ancestors are stale — rewrite the subtree closure in the same tx",
  },
  {
    card: "rollupChild",
    step: "update.maintainRollups",
    phase: "maintain",
    after: ["update.execUpdate", "update.captureBeforeImage"],
    why: "sum delta needs the OLD field value (the before image); same tx",
  },
  {
    card: "audit",
    step: "update.audit",
    phase: "record",
    after: ["update.execUpdate"],
    why:
      "after = prior image overlaid with the patch — exact for the diff's scalar columns",
  },
  {
    card: "vector",
    step: "update.restampVectorOnSourceChange",
    phase: "maintain",
    after: ["update.execUpdate"],
    why:
      "re-stamp + re-enqueue ONLY when the patch touched the source field — an untouched source keeps a valid embedding",
  },
  {
    card: "readModel",
    step: "update.enqueueReadModelUpsert",
    phase: "maintain",
    after: ["update.execUpdate"],
  },
];

export const REMOVE_WEAVE: readonly WeaveEntry[] = [
  {
    card: "immutable",
    step: "remove.wholeImmutableGuard",
    phase: "guard",
    why:
      "whole-resource immutable removes delete (append-only); field-level immutable keeps it",
  },
  { card: "_core", step: "remove.whereId", phase: "where" },
  { card: "scope", step: "remove.whereScope", phase: "where" },
  {
    card: "rowPolicy",
    step: "remove.whereRowPolicy",
    phase: "where",
    why:
      "appended BEFORE the soft-delete deleted_by stamps (which allocate later placeholders) and REUSED by the rollup pre-read — a hidden row drives no maintenance",
  },
  {
    card: "expiry",
    step: "remove.wherePurgeGuard",
    phase: "where",
    why:
      "re-assert the purge predicate INSIDE the delete tx — a revived (or concurrently soft-deleted) row matches 0 rows, never a silent tombstone or double decrement",
  },
  {
    card: "softDelete",
    step: "remove.whereLiveGuard",
    phase: "where",
    why:
      "the user delete door only matches a LIVE row — a 2nd remove() of a tombstoned child must not re-stamp, re-decrement (count/sum go negative), or write a phantom audit row; purge path carries its own inline live conjunct",
  },
  { card: "versioning", step: "remove.whereVersionCas", phase: "where" },
  {
    card: "rollupChild",
    step: "remove.lockRollupEdges",
    phase: "serialize",
    after: ["remove.whereVersionCas"],
    why:
      "(withCascade): edge lock BEFORE any row lock (the stale-precheck FOR UPDATE, audit FOR UPDATE, sweeps, DELETE) — the advisory-first order that keeps remove(P) ∥ update(P)/child writes deadlock-free (repo-rollup.ts)",
  },
  {
    card: "versioning",
    step: "remove.stalePrecheck",
    phase: "guard",
    after: ["remove.whereVersionCas", "remove.lockRollupEdges"],
    why:
      "LOCK the parent row (FOR UPDATE) BEFORE the cascade/restrict sweeps: (versioned) return stale on a CAS miss — else a version bump between a non-locking precheck and the sweeps orphans children; (non-versioned + a child-reading sweep, REL-01 sibling a) serialize a concurrent create(child)'s assertParentsLive FOR SHARE so the sweep sees it or the create refuses. Runs AFTER lockRollupEdges (advisory edge lock precedes this row lock)",
  },
  {
    card: "audit",
    step: "remove.captureBeforeImage",
    phase: "preImage",
    after: ["remove.lockRollupEdges"],
    why: "the full prior image, captured BEFORE the row is gone",
  },
  {
    card: "rollupChild",
    step: "remove.captureRollupTargets",
    phase: "preImage",
    after: ["remove.lockRollupEdges"],
    why:
      "parent ids + aggregated field values must be read BEFORE the delete (WHERE-gated: a guarded-out row yields none)",
  },
  {
    card: "onDeleteSweeps",
    step: "remove.sweepOnDelete",
    phase: "cascade",
    after: ["remove.stalePrecheck", "remove.captureRollupTargets"],
    why:
      "restrict pre-checks FIRST (a surviving child aborts); cascade/set-null clear the FK path BEFORE a hard parent delete would be FK-blocked",
  },
  {
    card: "tree",
    step: "remove.sweepTreeChildren",
    phase: "cascade",
    after: ["remove.stalePrecheck"],
    why:
      "the tree card's onParentDelete against this node's OWN children, same ordering rationale",
  },
  {
    card: "_core",
    step: "remove.execDelete",
    phase: "rowWrite",
    after: [
      "remove.sweepOnDelete",
      "remove.sweepTreeChildren",
      "remove.captureRollupTargets",
      "remove.captureBeforeImage",
    ],
    why:
      "soft: UPDATE deleted_at (+ deleted_by iff onRow); hard: DELETE RETURNING id + file cols → same-tx GC enqueue; RETURNING count is the affected truth",
  },
  {
    card: "rollupChild",
    step: "remove.maintainRollups",
    phase: "maintain",
    after: ["remove.execDelete"],
    why: "decrement/recompute only on a real delete (affected > 0)",
  },
  {
    card: "audit",
    step: "remove.audit",
    phase: "record",
    after: ["remove.execDelete"],
    why: "op normalized to 'delete' for soft AND hard — from:<value>→to:null",
  },
  {
    card: "readModel",
    step: "remove.enqueueReadModelDrop",
    phase: "maintain",
    after: ["remove.execDelete"],
    why:
      "soft OR hard: the projection must not linger as a stale image of a gone row",
  },
];

export const RESTORE_WEAVE: readonly WeaveEntry[] = [
  {
    card: "softDelete",
    step: "restore.softDeleteOnlyGuard",
    phase: "guard",
    why: "restore() exists iff softDelete — nothing to undo otherwise",
  },
  {
    card: "onRow",
    step: "restore.clearDeletedByColumns",
    phase: "columns",
    why: "a restored row is indistinguishable from a never-deleted one",
  },
  { card: "_core", step: "restore.whereId", phase: "where" },
  { card: "scope", step: "restore.whereScope", phase: "where" },
  {
    card: "softDelete",
    step: "restore.whereTombstoned",
    phase: "where",
    why:
      "only a soft-deleted row can be restored — live/missing/cross-scope → 0 rows",
  },
  {
    card: "rowPolicy",
    step: "restore.whereRowPolicy",
    phase: "where",
    why: "an actor cannot UN-DELETE a row their rowPolicy hides",
  },
  {
    card: "rollupChild",
    step: "restore.lockRollupEdges",
    phase: "serialize",
    why:
      "restore re-stamps the parent's rollups on the same up-edge update/remove lock — take it BEFORE the pre-read",
  },
  {
    card: "rollupChild",
    step: "restore.captureRollupTargets",
    phase: "preImage",
    after: ["restore.lockRollupEdges"],
    why:
      "field values survive a soft delete — captured from the still-tombstoned row",
  },
  {
    card: "_core",
    step: "restore.execRestore",
    phase: "rowWrite",
    after: [
      "restore.whereTombstoned",
      "restore.clearDeletedByColumns",
      "restore.captureRollupTargets",
    ],
  },
  {
    card: "rollupChild",
    step: "restore.maintainRollups",
    phase: "maintain",
    after: ["restore.execRestore"],
    why:
      "the increment MIRROR of remove: count +1 / sum +delta; avg/min/max recompute AFTER deleted_at cleared so the re-added child is back in the aggregate set",
  },
  {
    card: "audit",
    step: "restore.audit",
    phase: "record",
    after: ["restore.execRestore"],
    why: "one audit row (op='restore') per applied restore",
  },
  {
    card: "readModel",
    step: "restore.enqueueReadModelUpsert",
    phase: "maintain",
    after: ["restore.execRestore"],
    why:
      "the row is readable again, so the projection remove dropped must come back — the mirror of remove.enqueueReadModelDrop",
  },
];

export const WEAVES: Readonly<Record<WriteVerb, readonly WeaveEntry[]>> = {
  create: CREATE_WEAVE,
  update: UPDATE_WEAVE,
  remove: REMOVE_WEAVE,
  restore: RESTORE_WEAVE,
};

// ── derivations (consumed by app-boot / repo verbs) ──────────────────────────────────────────────

/** tamperVolatileCols: the framework-rewritten columns a tamper stamp must exclude from its hash.
 *  Fold order is pinned (encrypted → vector shadows → own rollups) to preserve the composed value byte-for-byte. */
const VOLATILE_FOLD_ORDER: readonly WriteCardKey[] = [
  "encrypted",
  "vector",
  "rollups",
  "immutable",
];
export function volatileColsOf(view: VolatileView): string[] {
  return VOLATILE_FOLD_ORDER.flatMap((k) =>
    WRITE_CARDS[k].volatileCols?.(view) ?? []
  );
}

/** update()'s writable-surface modifiers folded from the cards: `allow` widens the SET loop to
 *  framework lifecycle columns the owning feature makes caller-editable; `denyStatus`
 *  subtracts the FSM-owned status column. */
export function updateWritableOf(
  model: ResourceModel,
): { allow: ReadonlySet<string>; denyStatus: boolean } {
  const allow = new Set<string>();
  let denyStatus = false;
  for (const key of Object.keys(WRITE_CARDS) as WriteCardKey[]) {
    const w = WRITE_CARDS[key].updateWritable;
    if (!w) continue;
    for (const c of w.allows?.(model) ?? []) allow.add(c);
    if ((w.denies?.(model) ?? []).includes("status")) denyStatus = true;
  }
  return { allow, denyStatus };
}

/** The framework-minted lifecycle columns a create may carry from the caller (the `Insertable` face's
 *  caller-suppliable exceptions): temporal's `valid_from`/`valid_to` (04-features.md §temporal) and expiry's
 *  `expires_at` (§expiry). A supplied value threads verbatim; an absent one gets the DDL default (pinned by
 *  the temporal noOverlap teeth). */
export function createSuppliableOf(model: ResourceModel): ReadonlySet<string> {
  const allow = new Set<string>();
  if (model.features.temporal) {
    allow.add("valid_from");
    allow.add("valid_to");
  }
  if (model.features.expiry) allow.add("expires_at");
  return allow;
}

/** Does this patch force the pre-image read for rollup maintenance? (update.captureBeforeImage's
 *  rollup half): a field-bearing, non-count rollup whose aggregated field the patch touches. */
export function rollupNeedsBeforeImage(
  model: ResourceModel,
  patch: Record<string, unknown>,
): boolean {
  return model.rollupTargets.some((rt) =>
    rt.field !== undefined && rt.kind !== "count" && rt.field in patch
  );
}

// ── the interpreter ──────────────────────────────────────────────────────────────────────────────

/** A step signals an early return by resolving `{ halt: <verb result> }`; `undefined`/void continues. */
export interface StepHalt<R> {
  readonly halt: R;
}
export type StepFn<W, R> = (
  w: W,
) => Promise<StepHalt<R> | undefined | void> | StepHalt<R> | undefined | void;

/** Run one verb's weave over its binding table. A weave step with no binding is a loud error (a
 *  mis-wired verb must never silently skip a feature step — the exact failure mode this plan kills). */
export async function runWeave<W, R>(
  weave: readonly WeaveEntry[],
  bindings: Readonly<Record<string, StepFn<W, R>>>,
  w: W,
): Promise<StepHalt<R> | undefined> {
  for (const entry of weave) {
    const fn = bindings[entry.step];
    if (!fn) {
      throw new Error(
        `write-plan: step '${entry.step}' has no binding — the ${entry.card} card's contribution is not wired`,
      );
    }
    const r = await fn(w);
    if (r !== undefined) return r;
  }
  return undefined;
}
