// Validate native cursor values before read-page-sql casts them to a bounded type.
import type { ResourceModel } from "../core/app.ts";
import { NativeFilterValueError } from "../core/lower-sql.ts";
import type { Db } from "./db.ts";
import { assertNativeTextValues, NativeTextInputError } from "./native-cast.ts";
import {
  cursorKey,
  cursorTupleValues,
  CursorValidationError,
  decodeCursor,
  type Page,
} from "./read-page.ts";

export async function assertNativeCursor(
  db: Db,
  model: ResourceModel,
  page: Page | undefined,
): Promise<void> {
  if (page?.after === undefined) return;
  const key = cursorKey(page, model);
  const values = cursorTupleValues(key, decodeCursor(page.after));
  try {
    await assertNativeTextValues(
      db,
      model,
      key.map((column, index) => [column, values[index]] as const),
      true,
    );
  } catch (error) {
    if (
      error instanceof NativeTextInputError ||
      error instanceof NativeFilterValueError
    ) {
      throw new CursorValidationError(
        "a native key is not valid for its declared type",
      );
    }
    throw error;
  }
}
