type StringChecks = {
  readonly def: {
    readonly checks?: readonly {
      readonly _zod?: {
        readonly def?: {
          readonly check?: string;
          readonly maximum?: number;
          readonly minimum?: number;
          readonly length?: number;
        };
      };
    }[];
  };
};

/** Zod string maximum, including an impossible NaN check; repeated checks all apply. */
export function stringMaxLength(
  schema: StringChecks,
  includeExact = false,
): number | undefined {
  let bound: number | undefined;
  for (const check of schema.def.checks ?? []) {
    const def = check._zod?.def;
    const maximum = def?.check === "max_length"
      ? def.maximum
      : includeExact && def?.check === "length_equals"
      ? def.length
      : undefined;
    if (typeof maximum === "number") {
      bound = bound === undefined ? maximum : Math.min(bound, maximum);
    }
  }
  return bound;
}

/** Zod string minimum, including an impossible NaN check; repeated checks all apply. */
export function stringMinLength(schema: StringChecks): number | undefined {
  let bound: number | undefined;
  for (const check of schema.def.checks ?? []) {
    const def = check._zod?.def;
    const minimum = def?.check === "min_length"
      ? def.minimum
      : def?.check === "length_equals"
      ? def.length
      : undefined;
    if (typeof minimum === "number") {
      bound = bound === undefined ? minimum : Math.max(bound, minimum);
    }
  }
  return bound;
}
