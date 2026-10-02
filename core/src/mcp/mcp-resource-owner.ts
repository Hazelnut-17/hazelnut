import type { App, ResourceModel } from "../core/app.ts";

/** One model's actual opt-in to the app-resource URI axis. */
export function resourceFindEntry(
  m: ResourceModel,
):
  | { op: string; entry: { describe: string; shape?: readonly string[] } }
  | null {
  for (const op of ["find", "get"]) {
    const entry = m.mcp[op] as {
      describe: string;
      shape?: readonly string[];
      as?: "resource";
    } | undefined;
    if (entry?.as === "resource") return { op, entry };
  }
  return null;
}

/** The wire identity is independent of pgSchema and caller visibility. */
export function resourceUriTemplate(m: ResourceModel): string {
  return `${m.module}/${m.name}/{id}`;
}

/** Complete declared URI owners; catalog, dispatch and boot share this producer. */
export function resourceOwners(app: App) {
  return app.model.flatMap((model) => {
    const read = resourceFindEntry(model);
    return read
      ? [{ model, ...read, uriTemplate: resourceUriTemplate(model) }]
      : [];
  });
}
