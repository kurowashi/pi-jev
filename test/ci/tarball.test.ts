/**
 * Contract: what `npm pack` would ship from each workspace package.
 *
 * The expected list is computed from the files on disk and compared as a set,
 * so packing tests, configs, or anything else outside src/ fails. The guard
 * packages add their README; core has none.
 *
 * `--ignore-scripts` keeps the root `prepare` hook (lefthook) out of the
 * package output and the check side-effect free.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/loader.ts";

const PACKAGE_DIRS = ["packages/core", "packages/content-guard", "packages/placement-guard"];

interface PackFile {
	path?: unknown;
}

for (const dir of PACKAGE_DIRS) {
	test(`${dir} packs exactly its src tree and metadata`, () => {
		const packageRoot = join(REPO_ROOT, dir);
		const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: packageRoot,
			encoding: "utf8",
		});
		const parsed = JSON.parse(output) as Array<{ files?: PackFile[] }>;
		const shipped = (parsed[0]?.files ?? [])
			.map((file) => file.path)
			.filter((path): path is string => typeof path === "string")
			.sort();

		const metadata = ["package.json"];
		if (existsSync(join(packageRoot, "README.md"))) metadata.push("README.md");
		const source = readdirSync(join(packageRoot, "src"), { withFileTypes: true, recursive: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(packageRoot, join(entry.parentPath, entry.name)));
		const expected = [...metadata, ...source].sort();
		assert.deepEqual(shipped, expected, `${dir} may only publish src/ and package metadata`);
	});
}
