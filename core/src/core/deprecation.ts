import { z } from "zod";

const ISO_DATE = z.iso.date();
const ISO_INSTANT = z.iso.datetime({ offset: true });

/** Header dates must identify a finite instant without depending on the deployment's local timezone. */
export function deprecationErrors(metadata: unknown, site: string): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const declared = metadata as { deprecated?: unknown; sunset?: unknown };
  const errors: string[] = [];
  const instants = new Map<string, number>();
  for (const key of ["deprecated", "sunset"] as const) {
    const raw = declared[key];
    if (raw === undefined) continue;
    if (
      typeof raw !== "string" ||
      (!ISO_DATE.safeParse(raw).success &&
        !ISO_INSTANT.safeParse(raw).success) ||
      !Number.isFinite(new Date(raw).getTime())
    ) {
      errors.push(
        `deprecation/iso-date: ${site}.${key} must be a valid ISO calendar date or timestamp with an explicit timezone`,
      );
    } else instants.set(key, new Date(raw).getTime());
  }
  if (
    instants.has("deprecated") && instants.has("sunset") &&
    instants.get("sunset")! < instants.get("deprecated")!
  ) {
    errors.push(
      `deprecation/date-order: ${site}.sunset must be at or after deprecated`,
    );
  }
  return errors;
}
