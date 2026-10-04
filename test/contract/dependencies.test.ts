/**
 * Contract: the dependency policy of the monorepo.
 *
 * The guards share plumbing through the workspace link, never through a
 * registry package, and core itself has no runtime dependencies. Tooling lives
 * at the root. Every source import must stay inside the workspace or the Pi
 * package boundary.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../helpers/loader.ts";

/** Packages Pi injects into an extension process. */
const PI_PACKAGES = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);

/** Tooling allowed at the repository root. */
const ROOT_DEV_ALLOWED = new Set([
	"@biomejs/biome",
	"@earendil-works/pi-coding-agent",
	"@types/node",
	"knip",
	"lefthook",
	"typescript",
]);

const PACKAGE_DIRS = ["packages/core", "packages/content-guard", "packages/placement-guard"];

interface Manifest {
	engines?: { node?: string };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function readManifest(relativeDir: string): Manifest {
	return JSON.parse(readFileSync(join(REPO_ROOT, relativeDir, "package.json"), "utf8")) as Manifest;
}

test("the root manifest uses only reviewed dev tooling", () => {
	const manifest = readManifest(".");
	assert.equal(manifest.engines?.node, ">=22.19.0");
	for (const name of Object.keys(manifest.devDependencies ?? {})) {
		assert.ok(ROOT_DEV_ALLOWED.has(name), `root dev dependency ${name} is not in the reviewed set`);
	}
});

test("package runtime dependencies stay inside the workspace", () => {
	for (const dir of PACKAGE_DIRS) {
		for (const name of Object.keys(readManifest(dir).dependencies ?? {})) {
			assert.ok(name.startsWith("@pi-jev/"), `${dir}: runtime dependency ${name} must be a workspace package`);
		}
	}
});

test("package peer dependencies are supplied by Pi, and Node range matches", () => {
	for (const dir of PACKAGE_DIRS) {
		const manifest = readManifest(dir);
		assert.equal(manifest.engines?.node, ">=22.19.0", `${dir} must declare the supported Node range`);
		for (const name of Object.keys(manifest.peerDependencies ?? {})) {
			assert.ok(PI_PACKAGES.has(name), `${dir}: peer dependency ${name} is not supplied by Pi`);
		}
	}
});

test("source imports stay inside the workspace or the Pi boundary", () => {
	const offenders: string[] = [];
	for (const dir of PACKAGE_DIRS) {
		for (const file of sourceFiles(join(REPO_ROOT, dir, "src"))) {
			for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
				if (!isAllowed(specifier)) offenders.push(`${file.replace(REPO_ROOT, ".")} -> ${specifier}`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});

function isAllowed(specifier: string): boolean {
	if (specifier.startsWith("node:")) return true;
	if (specifier.startsWith(".")) return specifier.endsWith(".ts");
	const owner = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	if (owner === undefined) return false;
	return owner === "@pi-jev/core" || PI_PACKAGES.has(owner);
}

function importSpecifiers(source: string): string[] {
	return [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].flatMap((match) => match[1] ?? []);
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}
