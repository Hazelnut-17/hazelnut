// Build-time capability probe over the shipped repo layer — a leaf of the structural roster.
import { semanticSearch } from "../data/repo.ts";
import { withoutComments } from "./source-view.ts";

/** Does a function's SOURCE really set `hnsw.iterative_scan`? Comments are blanked first — otherwise a
 *  comment naming the setting keeps the answer true after the statement is gone, which is the one edit this
 *  probe exists to catch. The SET LOCAL is a string literal, so literals stay. Exported so a tooth drives
 *  THIS predicate rather than restating it (a restated copy stays green when the real one is weakened). */
export function setsIterativeScan(fnSource: string): boolean {
  return /hnsw\.iterative_scan/.test(withoutComments(fnSource));
}

/** Does the shipped `semanticSearch` set it? Reflected off the LIVE function, so deleting the `SET LOCAL`
 *  line in repo.ts flips this false and fires `vector/filtered-scan-complete` (without iterative scan,
 *  post-filtering the raw top-K silently under-returns authorized rows). */
export const REPO_SEMANTIC_SEARCH_HAS_ITERATIVE_SCAN: boolean =
  setsIterativeScan(semanticSearch.toString());
