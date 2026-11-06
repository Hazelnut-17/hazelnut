import type { App, ResourceModel } from "../core/app.ts";

type ResourceReadOptIn = {
  op: string;
  entry: { describe: string; shape?: readonly string[] };
};

function resourceReadOptIns(m: ResourceModel): ResourceReadOptIn[] {
  const out: ResourceReadOptIn[] = [];
  for (const op of ["find", "get"]) {
    const entry = m.mcp[op] as {
      describe: string;
      shape?: readonly string[];
      as?: "resource";
    } | undefined;
    if (entry?.as === "resource") out.push({ op, entry });
  }
  return out;
}

/** The wire identity is independent of pgSchema and caller visibility. */
export function resourceUriTemplate(m: ResourceModel): string {
  return `${m.module}/${m.name}/{id}`;
}

/** Complete declared URI owners; catalog, dispatch and boot share this producer.
 *  `find` and `get` on one model are two owners of one URI, not a first match. */
export function resourceOwners(app: App) {
  return app.model.flatMap((model) =>
    resourceReadOptIns(model).map((read) => ({
      model,
      ...read,
      uriTemplate: resourceUriTemplate(model),
    }))
  );
}
