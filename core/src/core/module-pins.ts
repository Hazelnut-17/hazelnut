/**
 * Certified (module, version) → core version tuples.
 *
 * A published capability module has its OWN version. Core's version is `FRAMEWORK_VERSION`. The
 * constraint is one resolved copy of core, not equal tarball numbers: each module version is
 * certified against exactly one core version. A module-only fix adds a row with the same `core`;
 * a core change is the moment existing runtime modules recut (new row, new module version, new
 * `core`). `hazelnut doctor` (`pin/certified`) is the consumer tooth.
 *
 * Historical rows stay: a published version is never replaced, and an app still pinning it must
 * doctor green.
 */
import { cmpVersion, FRAMEWORK_VERSION } from "./version.ts";

export interface CertifiedModulePin {
  readonly module: string;
  readonly version: string;
  readonly core: string;
}

export const CERTIFIED_MODULE_PINS: readonly CertifiedModulePin[] = [
  { module: "ai", version: "0.2.3", core: "0.2.3" },
  { module: "ai", version: "0.3.0", core: "0.3.0" },
  { module: "ai", version: "0.3.1", core: "0.3.1" },
  { module: "ai", version: "0.3.3", core: "0.3.3" },
  { module: "ai", version: "0.3.4", core: "0.3.4" },
  { module: "ai", version: "0.3.5", core: "0.3.5" },
  { module: "ai", version: "0.3.6", core: "0.3.6" },
  { module: "ai", version: "0.3.7", core: "0.3.7" },
  { module: "ai", version: "0.4.0", core: "0.4.0" },
  { module: "ai", version: "0.4.1", core: "0.4.1" },
  { module: "ai", version: "0.4.2", core: "0.4.2" },
  { module: "ai", version: "0.4.3", core: "0.4.3" },
  { module: "ai", version: "0.5.0", core: "0.5.0" },
  { module: "ai", version: "0.5.1", core: "0.5.1" },
  { module: "ai", version: "0.5.2", core: "0.5.2" },
  { module: "ai", version: "0.5.3", core: "0.5.3" },
  { module: "ai", version: "0.5.4", core: "0.5.4" },
  { module: "ai", version: "0.5.5", core: "0.5.5" },
  { module: "ai", version: "0.5.6", core: "0.5.6" },
  { module: "ai", version: "0.5.7", core: "0.5.7" },
  { module: "ai", version: "0.5.8", core: "0.5.8" },
  { module: "ai", version: "0.5.9", core: "0.5.9" },
  { module: "ai", version: "0.6.0", core: "0.6.0" },
  { module: "ai", version: "0.6.1", core: "0.6.1" },
  { module: "ai", version: "0.6.2", core: "0.6.2" },
  { module: "ai", version: "0.6.3", core: "0.6.3" },
  { module: "ai", version: "0.6.4", core: "0.6.4" },
  { module: "ai", version: "0.6.5", core: "0.6.5" },
];

/** The core version this module tarball was certified against, or `null` if it was never published. */
export function certifiedCore(
  module: string,
  version: string,
): string | null {
  return CERTIFIED_MODULE_PINS.find((p) =>
    p.module === module && p.version === version
  )?.core ??
    null;
}

/** The module version this tree publishes against `coreVersion` — the highest certified row. */
export function currentModuleVersion(
  module: string,
  coreVersion: string = FRAMEWORK_VERSION,
): string | null {
  const rows = CERTIFIED_MODULE_PINS.filter((p) =>
    p.module === module && p.core === coreVersion
  );
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => cmpVersion(a.version, b.version) >= 0 ? a : b)
    .version;
}
