import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	type BaseConfig,
	isIgnored,
	loadConfig,
	loadConfigFromDir,
	matchRules,
	resolveBaseSettings,
	stringListSetting,
} from "../src/index.ts";

// A name no other project uses, so a stray config on the way to the filesystem
// root cannot influence the tests.
const CONFIG = ".pi-jev-core-test.json";

interface TreeConfig extends BaseConfig {
	treeIgnore?: string | string[];
}

function makeDir(files: Record<string, string> = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-core-"));
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(root, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf8");
	}
	return root;
}

test("loadConfig adopts the nearest config", () => {
	const root = makeDir({
		[CONFIG]: JSON.stringify({ context: "root" }),
		[`pkg/${CONFIG}`]: JSON.stringify({ context: "pkg" }),
	});
	const target = path.join(root, "pkg/a.ts");

	const config = loadConfig(CONFIG, target, root, true, () => {});
	assert.equal(config?.file, path.join(root, "pkg", CONFIG));
	assert.equal(config?.baseDir, path.join(root, "pkg"));
	assert.equal(config?.config.context, "pkg");
});

test("loadConfig walks above the working directory when trusted", () => {
	const root = makeDir({ [CONFIG]: JSON.stringify({ context: "parent" }) });
	const child = path.join(root, "child");
	fs.mkdirSync(child);

	const config = loadConfig(CONFIG, path.join(child, "a.ts"), child, true, () => {});
	assert.equal(config?.file, path.join(root, CONFIG));
});

test("loadConfig ignores the config when the project is not trusted", () => {
	const root = makeDir({ [CONFIG]: JSON.stringify({}) });
	const warnings: string[] = [];

	const config = loadConfig(CONFIG, path.join(root, "a.ts"), root, false, (warning) => warnings.push(warning));
	assert.equal(config, undefined);
	assert.equal(warnings.length, 1);
	const [warning] = warnings;
	assert.ok(warning);
	assert.match(warning, /not trusted/);
});

test("loadConfig ignores the config when the file is outside the working directory", () => {
	const project = makeDir();
	const other = makeDir({ [CONFIG]: JSON.stringify({}) });
	const warnings: string[] = [];

	const config = loadConfig(CONFIG, path.join(other, "b.ts"), project, true, (warning) => warnings.push(warning));
	assert.equal(config, undefined);
	assert.equal(warnings.length, 1);
	const [warning] = warnings;
	assert.ok(warning);
	assert.match(warning, /outside the working directory/);
});

test("loadConfigFromDir starts at the given directory", () => {
	const root = makeDir({ [CONFIG]: JSON.stringify({ context: "root" }) });
	const child = path.join(root, "child");
	fs.mkdirSync(child);

	const config = loadConfigFromDir(CONFIG, child, root, true, () => {});
	assert.equal(config?.file, path.join(root, CONFIG));
});

test("resolveBaseSettings reads one config and rejects malformed values", () => {
	const root = makeDir({
		[CONFIG]: JSON.stringify({
			enabled: false,
			onError: "block",
			endpoint: "  https://example.test  ",
			minProbability: "high",
			maxFileChars: 12_000,
			timeoutSeconds: 30,
			context: "  trim me  ",
		}),
	});

	const config = loadConfig(CONFIG, path.join(root, "a.ts"), root, true, () => {});
	assert.ok(config);
	const settings = resolveBaseSettings(config);
	assert.equal(settings.enabled, false);
	assert.equal(settings.onError, "block");
	assert.equal(settings.endpoint, "https://example.test");
	assert.equal(settings.minProbability, 0.5);
	assert.equal(settings.maxFileChars, 12_000);
	assert.equal(settings.timeoutMs, 30_000);
	assert.equal(settings.includeFileName, true);
	assert.equal(settings.context, "trim me");
});

test("resolveBaseSettings falls back to defaults without a config", () => {
	const settings = resolveBaseSettings(undefined);
	assert.equal(settings.enabled, true);
	assert.equal(settings.onError, "allow");
	assert.equal(settings.minProbability, 0.5);
	assert.equal(settings.maxFileChars, 40_000);
	assert.equal(settings.timeoutMs, 20_000);
	assert.equal(settings.includeFileName, true);
});

test("stringListSetting accepts a string or an array and drops blanks", () => {
	const array = makeDir({ [CONFIG]: JSON.stringify({ treeIgnore: ["a", "  ", "b"] }) });
	const arrayConfig = loadConfig<TreeConfig>(CONFIG, path.join(array, "a.ts"), array, true, () => {});
	assert.deepEqual(stringListSetting(arrayConfig, "treeIgnore"), ["a", "b"]);

	const single = makeDir({ [CONFIG]: JSON.stringify({ treeIgnore: " only " }) });
	const singleConfig = loadConfig<TreeConfig>(CONFIG, path.join(single, "a.ts"), single, true, () => {});
	assert.deepEqual(stringListSetting(singleConfig, "treeIgnore"), ["only"]);
});

test("matchRules uses only the adopted config", () => {
	const root = makeDir({
		[CONFIG]: JSON.stringify({ rules: [{ name: "Root", files: ["**/*.ts"], checks: ["x"] }] }),
		[`pkg/${CONFIG}`]: JSON.stringify({ rules: [] }),
	});
	const target = path.join(root, "pkg/a.ts");

	const config = loadConfig(CONFIG, target, root, true, () => {});
	assert.deepEqual(matchRules(config, target), []);
});

test("matchRules skips disabled rules and the ignore glob wins", () => {
	const root = makeDir({
		[CONFIG]: JSON.stringify({
			ignore: ["**/__init__.py"],
			rules: [
				{ name: "On", files: ["**/*.py"], checks: ["x"] },
				{ name: "Off", files: ["**/*.py"], checks: ["y"], enabled: false },
			],
		}),
	});

	const config = loadConfig(CONFIG, path.join(root, "a.py"), root, true, () => {});
	assert.ok(config);
	assert.equal(isIgnored(config, path.join(root, "__init__.py")), true);
	assert.equal(isIgnored(config, path.join(root, "a.py")), false);
	assert.deepEqual(
		matchRules(config, path.join(root, "a.py")).map((match) => match.rule.name),
		["On"],
	);
});

test("matchAllWhenNoFiles applies a rule without files to every file", () => {
	const root = makeDir({ [CONFIG]: JSON.stringify({ rules: [{ name: "Any", checks: ["x"] }] }) });
	const target = path.join(root, "note.txt");

	const config = loadConfig(CONFIG, target, root, true, () => {});
	const names = (matches: ReturnType<typeof matchRules>) => matches.map((match) => match.rule.name);
	assert.deepEqual(names(matchRules(config, target, { matchAllWhenNoFiles: true })), ["Any"]);
	assert.deepEqual(names(matchRules(config, target)), []);
});

test("matching without a config yields nothing", () => {
	assert.equal(isIgnored(undefined, "/a.ts"), false);
	assert.deepEqual(matchRules(undefined, "/a.ts"), []);
});
