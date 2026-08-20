/** The `embed` seam (05-runtime.md §seams, the data.embed Port) — semantic-vector embeddings at rest. The
 *  framework owns DDL, staleness columns, outbox re-embed, and the read path; only the model call is
 *  off-machine (`config.embed ?? null`, the null-Kms posture in encrypt.ts, Port/adapter split like `Kms`). */
import { safeFetch } from "../runtime/safe-fetch.ts";

export interface EmbeddingProvider {
  /** Embed a batch of source texts → one fixed-width `Float32Array` per input (same order, same length).
   *  An external API call: never a generated column, never an in-tx compute (the async re-embed reason). */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** The model id stamped on the `<field>_model` shadow column — the dimension/model-change discriminator
   *  the expand-contract migrate keys the v2 backfill on (item 5; like an event `schema_version`). */
  readonly model: string;
  /** The fixed embedding width — must equal the declared `vector.dims` (a width mismatch is rejected at the
   *  pgvector substrate by-construction; this lets the stub/adapter assert its own contract too). */
  readonly dims: number;
}

/**
 * The vector declaration card (the `vector` key on `defineResource`). `field` is the minted vector column;
 * `source` is the text field whose value is embedded; `dims` is the embedding width (drives `vector(N)` vs
 * `halfvec(N)` routing — 2000 is the plain-`vector` index ceiling, larger needs `halfvec`); `model` is the
 * embedding model id stamped on the shadow column (the migrate/staleness discriminator). The 90% form is
 * the object; nothing is codegen'd — the DDL/repo/verify all derive from this one card.
 */
export interface VectorConfig {
  readonly field: string;
  readonly source: string;
  readonly dims: number;
  readonly model: string;
}

/** A narrow structural view of the runtime `vector` declaration value. */
type VectorInput = {
  readonly field: string;
  readonly source: string;
  readonly dims: number;
  readonly model?: string;
};

/** Normalize the declared `vector` card, or `null` when absent. `model` defaults to the sentinel `"unset"`
 *  so an omitted model still stamps a non-null discriminator (a model change is any move off that sentinel).
 *  Read once at createApp; every downstream (DDL, repo, verify) derives from the returned card. */
export function normalizeVector(
  raw: VectorInput | undefined,
): VectorConfig | null {
  if (raw === undefined) return null;
  return {
    field: raw.field,
    source: raw.source,
    dims: raw.dims,
    model: raw.model ?? "unset",
  };
}

/** The plain-`vector` HNSW index ceiling (pgvector §dims): a `vector(N)` column indexes to 2000 dims; a
 *  wider embedding (text-embedding-3-large @ 3072) must use `halfvec(N)` (to 4000). The routing pin. */
export const PLAIN_VECTOR_MAX_DIMS = 2000;

/** The pgvector column type for `dims` — `vector(N)` at/below the 2000 index ceiling, else `halfvec(N)`
 *  (item 2: route large dims to halfvec so the HNSW index can still be built). */
export function vectorColumnType(dims: number): string {
  return dims <= PLAIN_VECTOR_MAX_DIMS ? `vector(${dims})` : `halfvec(${dims})`;
}

/** The HNSW opclass that matches the column type — `vector_cosine_ops` for a plain vector, `halfvec_cosine_ops`
 *  for a halfvec (a halfvec column needs the half-precision opclass, or the index create fails). */
export function vectorOpClass(dims: number): string {
  return dims <= PLAIN_VECTOR_MAX_DIMS
    ? "vector_cosine_ops"
    : "halfvec_cosine_ops";
}

/**
 * Render a `Float32Array` as the pgvector text literal `[a,b,c]` the driver binds to a vector/halfvec
 * column. Deterministic, no precision loss beyond float32 (the column's own precision). The framework's
 * one vector-binding seam — both the create write and the re-embed drain write through it.
 */
export function vectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

const te = new TextEncoder();

/** The source-text hash stamped on `<field>_source_hash` — the staleness lie-detector's anchor. A stored
 *  hash that no longer equals `hash(current source text)` means the vector was embedded from an old source
 *  (`stored_hash != hash(current_text)`). SHA-256 hex; empty/null source hashes the empty string. */
export async function sourceHash(
  text: string | null | undefined,
): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    te.encode(text ?? "") as BufferSource,
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The staleness predicate (`vector/possibly-stale`): the stored source hash differs from the hash of the
 *  current source text → the vector is stale. Pure over the two values, so a read path or a verifier can
 *  flag the honest lie without recomputing the embedding. */
export function isVectorStale(
  storedHash: string | null | undefined,
  currentHash: string,
): boolean {
  return storedHash !== currentHash;
}

/** `stubEmbed({ model, dims })` — the deterministic in-process provider the tests drive (the toothed
 *  adapter behind the Port, like a counting/identity KMS in encrypt.ts): a pure seeded fill of the input
 *  text, so re-embed/backfill checks end-to-end without a network. Not similarity-meaningful — a fixture. */
export function stubEmbed(
  { model, dims }: { model: string; dims: number },
): EmbeddingProvider {
  return {
    model,
    dims,
    embed(texts: readonly string[]): Promise<Float32Array[]> {
      return Promise.resolve(texts.map((t) => {
        const v = new Float32Array(dims);
        // a stable seeded fill: each component derives from the text's char codes + its index, so two
        // distinct texts embed to distinct vectors and the same text is reproducible (deterministic fixture).
        let seed = 0;
        for (let i = 0; i < t.length; i++) {
          seed = (seed * 31 + t.charCodeAt(i)) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          v[i] = (seed % 1000) / 1000; // a bounded [0,1) component
        }
        return v;
      }));
    },
  };
}

/** `openaiEmbed({ model, dims, apiKey })` — the thin app-wired adapter (the real network Port impl), kept
 *  out of the toothed core like a real KMS adapter. A call to the OpenAI embeddings endpoint through the SSRF floor — no
 *  SDK dependency, so it stays a leaf the app opts into; returns the same Port the stub does. */
export function openaiEmbed(
  opts: {
    readonly model: string;
    readonly dims: number;
    readonly apiKey: string;
    readonly endpoint?: string;
    readonly fetchFn?: typeof fetch;
    readonly allowPrivateNetwork?: true;
  },
): EmbeddingProvider {
  const endpoint = opts.endpoint ?? "https://api.openai.com/v1/embeddings";
  return {
    model: opts.model,
    dims: opts.dims,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      // Through the SSRF floor, not a bare `fetch`: `endpoint` is caller-supplied, so without it an
      // `http://` endpoint sends the key in cleartext and a loopback/metadata address is reachable.
      // `redirect: "error"` also stops a 3xx from forwarding the bearer token to another host.
      const res = await safeFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          dimensions: opts.dims,
          input: texts,
        }),
      }, {
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        ...(opts.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      });
      if (!res.ok) {
        throw new Error(`embed: openai embeddings call failed (${res.status})`);
      }
      const json = await res.json() as {
        data?: ReadonlyArray<{ embedding?: readonly number[] }>;
      };
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        throw new Error(
          `embed: openai embeddings returned ${
            json.data?.length ?? 0
          } vectors for ${texts.length} inputs`,
        );
      }
      return json.data.map((d, i) => {
        const e = d.embedding;
        if (!Array.isArray(e) || e.length !== opts.dims) {
          throw new Error(
            `embed: openai embeddings vector ${i} has length ${
              e?.length ?? 0
            }, expected ${opts.dims}`,
          );
        }
        return Float32Array.from(e);
      });
    },
  };
}
