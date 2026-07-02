import { createRequire } from "node:module";

// The @meteora-ag/dlmm ESM build (dist/index.mjs) ships broken directory imports
// of @coral-xyz/anchor CJS internals, so we must load the CJS build. Its CJS
// interop footer replaces module.exports with the DLMM class and glues every
// named export onto it.
type DlmmModule = typeof import("@meteora-ag/dlmm");
type DlmmExports = DlmmModule["default"] & Omit<DlmmModule, "default">;

const require_ = createRequire(import.meta.url);
export const dlmm: DlmmExports = require_("@meteora-ag/dlmm");

export const DLMM_PROGRAM_ID = dlmm.LBCLMM_PROGRAM_IDS["mainnet-beta"] as string;
