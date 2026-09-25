import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import jevTreeGuard, {
	DEFAULT_TREE_IGNORE,
	globToRegExp,
	parseDotEnv,
	renderTemplate,
	renderTree,
} from "../extensions/jev-tree-guard.ts";

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

type ToolCallHandler = (event: unknown, ctx: unknown) => Promise<any>;

interface Harness {
	toolCall: ToolCallHandler;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
}

function harness(): Harness {
	let toolCall: ToolCallHandler | undefined;
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi = {
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCall = handler;
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options.handler);
		},
	};
	jevTreeGuard(pi as never);
	assert.ok(toolCall, "tool_call handler was not registered");
	return { toolCall, commands };
}

interface FakeContext {
	cwd: string;
	hasUI: boolean;
	mode: string;
	isProjectTrusted(): boolean;
	ui: {
		notify(message: string, type?: string): void;
		setStatus(key: string, text: string | undefined): void;
		select(): Promise<undefined>;
		confirm(): Promise<boolean>;
		input(): Promise<undefined>;
	};
	notifications: Array<{ message: string; type?: string }>;
}

function fakeContext(cwd: string, trusted = true): FakeContext {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		cwd,
		hasUI: false,
		mode: "print",
		isProjectTrusted: () => trusted,
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: () => {},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
		notifications,
	};
}

function makeProject(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-tree-guard-"));
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(root, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf8");
	}
	return root;
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function withFetch<T>(
	handler: (url: string, init: RequestInit) => Promise<Response>,
	fn: () => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = ((url: string, init: RequestInit) => handler(String(url), init)) as typeof fetch;
	return fn().finally(() => {
		globalThis.fetch = original;
	});
}

function jevResponse(probabilities: number[]): Response {
	const answers: Record<string, unknown> = {};
	probabilities.forEach((probability, index) => {
		answers[`check_${index}`] = { type: "noul", noul: probability };
	});
	return new Response(JSON.stringify({ answers, model: "test" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function writeEvent(filePath: string, content: string): unknown {
	return { type: "tool_call", toolName: "write", toolCallId: "1", input: { path: filePath, content } };
}

const CLEAN_ENV = {
	SYSTEMONE_API_KEY: undefined,
	TYPESAFE_API_KEY: undefined,
	OPENROUTER_API_KEY: undefined,
	OPENCODE_API_KEY: undefined,
	OPENCODE_ZEN_API_KEY: undefined,
	COMMANDCODE_API_KEY: undefined,
	SYSTEMONE_ENDPOINT: undefined,
	JEV_TREE_GUARD_DISABLE: undefined,
};

// ------------------------------------------------------------------------------------------------
// Unit tests
// ------------------------------------------------------------------------------------------------

test("globToRegExp handles **, *, and ?", () => {
	assert.ok(globToRegExp("**/*.ts").test("src/deep/a.ts"));
	assert.ok(globToRegExp("**/*.ts").test("a.ts"));
	assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
	assert.ok(!globToRegExp("src/*.ts").test("src/deep/a.ts"));
	assert.ok(globToRegExp("a?.md").test("ab.md"));
	assert.ok(!globToRegExp("a?.md").test("abc.md"));
	assert.ok(globToRegExp("docs/**").test("docs/x/y.md"));
});

test("renderTemplate replaces known placeholders and keeps unknown ones", () => {
	assert.equal(renderTemplate("x {file} {checks} {nope}", { file: "a.ts", checks: "- ok" }), "x a.ts - ok {nope}");
});

test("parseDotEnv reads quoted, exported, and commented values", () => {
	const dir = makeProject({
		".env": [
			"# comment",
			"PLAIN=value",
			"EXPORTED=export",
			'DOUBLE="a b"',
			"SINGLE='c d'",
			"TRAILING=value # note",
			"EMPTY=",
		].join("\n"),
	});
	assert.deepEqual(parseDotEnv(path.join(dir, ".env")), {
		PLAIN: "value",
		EXPORTED: "export",
		DOUBLE: "a b",
		SINGLE: "c d",
		TRAILING: "value",
	});
});

test("renderTree shows the existing structure with the new file marked", () => {
	const root = makeProject({
		"src/index.ts": "",
		"src/lib/util.ts": "",
		"docs/README.md": "",
	});
	const tree = renderTree(root, "src/lib/helper.ts");
	assert.match(tree.text, /^\.\/$/m);
	assert.match(tree.text, /^  src\/$/m);
	assert.match(tree.text, /^    lib\/$/m);
	assert.match(tree.text, /^      util\.ts$/m);
	assert.match(tree.text, /^      helper\.ts \(new\)$/m);
	assert.match(tree.text, /^  docs\/$/m);
	assert.equal(tree.focusDir, "src/lib");
	assert.deepEqual(tree.createdDirs, []);
	assert.equal(tree.truncated, false);
	assert.equal(tree.files, 4);
});

test("renderTree marks directories that would be created", () => {
	const root = makeProject({ "src/index.ts": "" });
	const tree = renderTree(root, "src/features/auth/login.ts");
	assert.match(tree.text, /features\/ \(new dir\)/);
	assert.match(tree.text, /auth\/ \(new dir\)/);
	assert.match(tree.text, /login\.ts \(new\)/);
	assert.deepEqual(tree.createdDirs, ["src/features", "src/features/auth"]);
});

test("renderTree hides ignored paths", () => {
	const root = makeProject({
		"src/a.ts": "",
		"node_modules/pkg/index.js": "",
		"dist/bundle.js": "",
	});
	const tree = renderTree(root, "src/new.ts", { ignore: DEFAULT_TREE_IGNORE });
	assert.doesNotMatch(tree.text, /node_modules/);
	assert.doesNotMatch(tree.text, /dist\//);
	assert.match(tree.text, /new\.ts \(new\)/);
});

test("renderTree always renders the target path when truncated", () => {
	const files: Record<string, string> = { "z/keep.ts": "" };
	for (let i = 0; i < 20; i++) files[`a/f${String(i).padStart(2, "0")}.txt`] = "";
	const root = makeProject(files);

	const tree = renderTree(root, "z/new.ts", { maxEntries: 5 });
	assert.equal(tree.truncated, true);
	assert.match(tree.text, /new\.ts \(new\)/);
	assert.doesNotMatch(tree.text, /truncated/);
});

test("renderTree excludes an existing file when dry-running it as new", () => {
	const root = makeProject({ "src/a.ts": "", "src/b.ts": "" });
	const tree = renderTree(root, "src/a.ts", { exclude: "src/a.ts" });
	assert.doesNotMatch(tree.text, /^    a\.ts$/m);
	assert.match(tree.text, /^    a\.ts \(new\)$/m);
});

// ------------------------------------------------------------------------------------------------
// Integration tests (mock Jev endpoint)
// ------------------------------------------------------------------------------------------------

test("blocks the creation of a misplaced new file", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			rules: [
				{
					name: "Placement",
					files: ["**/*.ts"],
					checks: ["Is the file in the right directory?"],
					fail: "blocked: {checks}",
				},
			],
		}),
		"src/index.ts": "export {};\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (url, init) => {
					assert.equal(url, "https://api.typesafe.ai/v1/systemone");
					assert.equal((init.headers as Record<string, string>).authorization, "Bearer test-key");
					const body = JSON.parse(String(init.body));
					assert.equal(body.model, "jev-1.13.0");
					assert.equal(typeof body.state, "string");
					assert.match(body.state, /^file: src\/features\/new\.ts \(new\)$/m);
					assert.match(body.state, /^project tree$/m);
					assert.match(body.state, /^  src\/$/m);
					assert.match(body.state, /features\/ \(new dir\)/);
					assert.match(body.state, /new\.ts \(new\)/);
					assert.match(body.state, /^file content$/m);
					assert.match(body.state, /export const x = 1;/);
					assert.match(body.state, /note: .*would be created: src\/features/);
					assert.equal(body.questions.check_0.type, "noul");
					assert.match(body.questions.check_0.instructions, /existing project file tree/);
					assert.match(body.questions.check_0.instructions, /Is the file in the right directory\?/);
					return jevResponse([0.1]);
				},
				() => toolCall(writeEvent("src/features/new.ts", "export const x = 1;\n"), ctx),
			),
		),
	);

	const block = result as { block: boolean; reason: string };
	assert.equal(block.block, true);
	assert.match(block.reason, /^blocked: /);
	assert.match(block.reason, /Is the file in the right directory\? \(satisfied 10%\)/);
	assert.equal(ctx.notifications.at(-1)?.type, "warning");
});

test("allows the creation when every check passes", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({ rules: [{ files: ["**/*.ts"], checks: ["Fits"] }] }),
		"src/index.ts": "",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => jevResponse([0.9]), () => toolCall(writeEvent("src/new.ts", "x\n"), ctx)),
		),
	);
	assert.equal(result, undefined);
});

test("does not check overwrites of existing files by default", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({ rules: [{ files: ["**/*.ts"], checks: ["Fits"] }] }),
		"src/a.ts": "old\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);
	let called = false;

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					called = true;
					return jevResponse([0.01]);
				},
				() => toolCall(writeEvent("src/a.ts", "new\n"), ctx),
			),
		),
	);
	assert.equal(result, undefined);
	assert.equal(called, false);
});

test("checks overwrites when onlyNewFiles is false", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			onlyNewFiles: false,
			rules: [{ files: ["**/*.ts"], checks: ["Fits"] }],
		}),
		"src/a.ts": "old\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					assert.match(body.state, /^file: src\/a\.ts \(overwrite\)$/m);
					assert.doesNotMatch(body.state, /a\.ts \(new\)/);
					assert.match(body.questions.check_0.instructions, /already present/);
					return jevResponse([0.99]);
				},
				() => toolCall(writeEvent("src/a.ts", "new\n"), ctx),
			),
		),
	);
	assert.equal(result, undefined);
});

test("a rule without files matches every new file", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({ rules: [{ name: "Any", checks: ["Fits"] }] }),
	});
	const { toolCall } = harness();
	let called = false;

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					called = true;
					return jevResponse([0.99]);
				},
				() => toolCall(writeEvent("misc/note.txt", "hi\n"), fakeContext(root)),
			),
		),
	);
	assert.equal(called, true);
});

test("does not check files that no rule matches", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({ rules: [{ files: ["**/*.py"], checks: ["Fits"] }] }),
	});
	const { toolCall } = harness();
	let called = false;

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					called = true;
					return jevResponse([0.01]);
				},
				() => toolCall(writeEvent("src/new.ts", "x\n"), fakeContext(root)),
			),
		),
	);
	assert.equal(result, undefined);
	assert.equal(called, false);
});

test("ignore prevents checks entirely", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			ignore: ["**/vendor/**"],
			rules: [{ files: ["**/*"], checks: ["Fits"] }],
		}),
	});
	const { toolCall } = harness();
	let called = false;

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					called = true;
					return jevResponse([0.01]);
				},
				() => toolCall(writeEvent("vendor/dep/index.ts", "x\n"), fakeContext(root)),
			),
		),
	);
	assert.equal(result, undefined);
	assert.equal(called, false);
});

test("negate asks for the failure mode and inverts its probability", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			rules: [
				{
					name: "Placement",
					files: ["**/*.ts"],
					negate: true,
					checks: ["Misplaced in an unrelated directory"],
					fail: "blocked ({probability}): {checks}",
				},
			],
		}),
	});
	const { toolCall } = harness();

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					assert.match(
						body.questions.check_0.instructions,
						/describes the new file: Misplaced in an unrelated directory/,
					);
					return jevResponse([0.9]);
				},
				() => toolCall(writeEvent("src/new.ts", "x\n"), fakeContext(root)),
			),
		),
	);
	const block = result as { block: boolean; reason: string };
	assert.equal(block.block, true);
	assert.match(block.reason, /^blocked \(10%\): /);
	assert.match(block.reason, /Misplaced in an unrelated directory \(negated, satisfied 10%\)/);
});

test("/jev-tree-guard check treats an existing file as a proposal", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			rules: [{ files: ["**/*.ts"], checks: ["Fits"] }],
		}),
		"src/a.ts": "export {};\n",
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-tree-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					assert.match(body.state, /^file: src\/a\.ts \(new\)$/m);
					assert.match(body.state, /^file content$/m);
					assert.match(body.state, /export \{\};/);
					assert.doesNotMatch(body.state, /^    a\.ts$/m);
					assert.match(body.state, /^    a\.ts \(new\)$/m);
					return jevResponse([0.9]);
				},
				() => handler("check src/a.ts", ctx),
			),
		),
	);

	const report = ctx.notifications.at(-1)?.message ?? "";
	assert.match(report, /jev-tree-guard check: src\/a\.ts/);
	assert.match(report, /PASS\s+90%/);
	assert.match(report, /state sent to Jev:/);
	assert.match(report, /file: src\/a\.ts \(new\)/);
});

test("/jev-tree-guard merges all matching rules into one request with their contexts", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			context: "global context",
			rules: [
				{ name: "Placement", files: "**/*.ts", context: "placement context", checks: ["Fits"] },
				{ name: "Style", files: "**/*.ts", context: "style context", checks: ["Tidy"] },
			],
		}),
	});
	const { toolCall } = harness();
	const bodies: Array<{ state: string; questions: Record<string, unknown> }> = [];

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					bodies.push(body);
					const answers: Record<string, unknown> = {};
					for (const name of Object.keys(body.questions)) answers[name] = { type: "noul", noul: 0.99 };
					return new Response(JSON.stringify({ answers }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
				() => toolCall(writeEvent("src/a.ts", "export {};\n"), fakeContext(root)),
			),
		),
	);

	assert.equal(bodies.length, 1);
	assert.match(bodies[0]!.state, /^global context\n\nplacement context\n\nstyle context\n\nfile: src\/a\.ts \(new\)/);
	assert.deepEqual(Object.keys(bodies[0]!.questions), ["check_0", "check_1"]);
});

test("/jev-tree-guard context shows the merged request without calling Jev", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({
			context: "Global tree convention.",
			rules: [
				{ name: "App", files: ["src/**/*.ts"], context: "App rule context.", checks: ["Fits"] },
				{ name: "Docs", files: ["docs/**/*.md"], checks: ["Fits"] },
			],
		}),
		"src/a.ts": "export {};\n",
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-tree-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () => handler("context src/a.ts", ctx));

	const report = ctx.notifications.at(-1)?.message ?? "";
	assert.match(report, /jev-tree-guard context: src\/a\.ts/);
	assert.match(report, /global context \(from .*\.jev-tree-guard\.json\)/);
	assert.match(report, /Global tree convention\./);
	assert.match(report, /rules merged into one request: 1 — App/);
	assert.match(report, /merged context \(2 part\(s\)\):/);
	assert.match(report, /App rule context\./);
	assert.match(report, /file line: file: src\/a\.ts \(new\)/);
	assert.match(report, /state sent to Jev \(as a new file\):/);
	assert.match(report, /^file: src\/a\.ts \(new\)$/m);
});

test("/jev-tree-guard context without a file lists the global context", async () => {
	const root = makeProject({
		".jev-tree-guard.json": JSON.stringify({ context: "Only global.", rules: [] }),
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-tree-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () => handler("context", ctx));

	const report = ctx.notifications.at(-1)?.message ?? "";
	assert.match(report, /jev-tree-guard context\b/);
	assert.match(report, /Only global\./);
	assert.match(report, /Rules need a target file/);
});
