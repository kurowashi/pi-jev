/**
 * Loads a guard extension through Pi's loader (jiti), the path Pi uses at
 * runtime, so the contract tests cover the shipped artifact and its real
 * wiring. The loader also scans project and global extension directories, so
 * both are redirected to an empty sandbox.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type Extension } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file: test/helpers/ -> ../.. */
export const REPO_ROOT = join(HERE, "..", "..");

/** The Pi extensions this repository ships, relative to the repository root. */
export const GUARD_DIRS = ["packages/content-guard", "packages/placement-guard"];

export async function loadGuard(relativeDir: string): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-jev-contract-"));
	const result = await discoverAndLoadExtensions([join(REPO_ROOT, relativeDir, "src", "index.ts")], sandbox, sandbox);
	assert.deepEqual(result.errors, [], `${relativeDir} must load without errors`);
	assert.equal(result.extensions.length, 1, `${relativeDir} must load exactly one extension`);
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	return extension;
}
