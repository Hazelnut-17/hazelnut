import type { ResourceModel } from "../core/app.ts";
import {
  type FileConstraints,
  fileConstraintsOf,
} from "../data/schema-types.ts";
import type { StorageDriver } from "../data/storage.ts";
import { err, ok, type Result } from "../core/result.ts";

export const FILE_STAGE_MAX_BYTES = 524_288;

export function fileConstraints(
  model: ResourceModel,
  field: string,
): FileConstraints | undefined {
  return fileConstraintsOf(model.schema.shape[field]);
}

export function hasFileConstraints(
  options: FileConstraints | undefined,
): boolean {
  return options?.maxBytes !== undefined ||
    options?.contentTypes !== undefined || options?.inspect !== undefined;
}

export function checkFileMetadata(
  options: FileConstraints | undefined,
  size: number,
  contentType?: string,
): Result<true> {
  if (
    hasFileConstraints(options) && (!Number.isSafeInteger(size) || size < 0)
  ) {
    return err(
      "internal",
      "file/content-metadata: storage returned an invalid byte count",
    );
  }
  if (options?.maxBytes !== undefined && size > options.maxBytes) {
    return err(
      "validation",
      "file/content-size: upload exceeds the field byte limit",
    );
  }
  if (
    options?.contentTypes &&
    (!contentType || !options.contentTypes.includes(contentType))
  ) {
    return err(
      "validation",
      "file/content-type: upload metadata is not allowed",
    );
  }
  return ok(true);
}

export async function inspectFile(
  options: FileConstraints | undefined,
  bytes: Uint8Array,
  contentType?: string,
): Promise<Result<true>> {
  if (!options?.inspect) return ok(true);
  try {
    return await options.inspect(bytes.slice(), { contentType }) === true
      ? ok(true)
      : err("validation", "file/content: upload failed content inspection");
  } catch {
    return err("validation", "file/content: upload failed content inspection");
  }
}

/** Re-read at finalization, bounding the stream even when metadata is incorrect. */
export async function inspectStoredFile(
  options: FileConstraints | undefined,
  storage: StorageDriver,
  key: string,
  contentType: string | undefined,
  limit: number,
): Promise<Result<true>> {
  if (!options?.inspect) return ok(true);
  if (!storage.get) {
    return err(
      "business",
      "file/stage-unsupported: content inspection requires storage reads",
    );
  }
  const object = await storage.get(key);
  if (!object) return err("conflict", "staged bytes are unavailable");
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return err(
          "validation",
          "file/content-size: stored upload exceeds the byte limit",
        );
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const metadata = checkFileMetadata(options, size, contentType);
  return metadata.ok
    ? await inspectFile(options, bytes, contentType)
    : metadata;
}
