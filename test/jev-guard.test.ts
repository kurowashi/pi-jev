import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import jevHooks, {
	globToRegExp,
	parseDotEnv,
	predictContent,
	renderTemplate,
} from "../extensions/jev-guard.ts";

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
	jevHooks(pi as never);
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-guard-"));
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

function withFetch<T>(handler: (url: string, init: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
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

const CLEAN_ENV = {
	SYSTEMONE_API_KEY: undefined,
	TYPESAFE_API_KEY: undefined,
	OPENROUTER_API_KEY: undefined,
	OPENCODE_API_KEY: undefined,
	OPENCODE_ZEN_API_KEY: undefined,
	COMMANDCODE_API_KEY: undefined,
	SYSTEMONE_ENDPOINT: undefined,
	JEV_GUARD_DISABLE: undefined,
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
			'PLAIN=value',
			'EXPORTED=export',
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

test("predictContent applies disjoint edits", () => {
	const dir = makeProject({ "a.txt": "one two three\n" });
	const result = predictContent(path.join(dir, "a.txt"), [
		{ oldText: "one", newText: "1" },
		{ oldText: "three", newText: "3" },
	]);
	assert.equal(result, "1 two 3\n");
});

test("predictContent refuses ambiguous or missing matches", () => {
	const dir = makeProject({ "a.txt": "same same\n" });
	assert.equal(predictContent(path.join(dir, "a.txt"), [{ oldText: "same", newText: "x" }]), undefined);
	assert.equal(predictContent(path.join(dir, "a.txt"), [{ oldText: "missing", newText: "x" }]), undefined);
	assert.equal(
		predictContent(path.join(dir, "a.txt"), [
			{ oldText: "same same", newText: "x" },
			{ oldText: "same", newText: "y" },
		]),
		undefined,
	);
});

// ------------------------------------------------------------------------------------------------
// Integration tests (mock Jev endpoint)
// ------------------------------------------------------------------------------------------------

test("blocks an edit when Jev rejects a check", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			rules: [{ name: "TS", files: "**/*.ts", checks: ["No bar"], fail: "blocked: {checks}" }],
		}),
		"src/a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (url, init) => {
					assert.equal(url, "https://api.typesafe.ai/v1/systemone");
					assert.equal((init.headers as Record<string, string>).authorization, "Bearer test-key");
					const body = JSON.parse(String(init.body));
					assert.equal(body.model, "jev-1.13.0");
					assert.equal(body.state.scope, "change");
					assert.match(body.state.change, /before\nfoo\n\+\+\+ after\nbar/);
					assert.equal(body.questions.check_0.type, "noul");
					assert.match(body.questions.check_0.instructions, /No bar/);
					return jevResponse([0.05]);
				},
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "edit",
							toolCallId: "1",
							input: { path: "src/a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
						},
						ctx,
					),
			),
		),
	).then((result) => {
		const block = result as { block: boolean; reason: string };
		assert.equal(block.block, true);
		assert.match(block.reason, /^blocked: /);
		assert.match(block.reason, /No bar \(satisfied 5%\)/);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
	});
});

test("allows an edit when every check passes", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => jevResponse([0.9]), () =>
				toolCall(
					{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "baz" }] } },
					ctx,
				),
			),
		),
	).then((result) => {
		assert.equal(result, undefined);
	});
});

test("negate asks for the failure mode and inverts its probability", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			rules: [
				{
					name: "Quality",
					files: "**/*.ts",
					checks: [{ check: "dirty code", negate: true }],
					fail: "blocked ({probability}): {checks}",
				},
			],
		}),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					assert.match(body.questions.check_0.instructions, /describes the new content: dirty code/);
					return jevResponse([0.8]);
				},
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "edit",
							toolCallId: "1",
							input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
						},
						ctx,
					),
			),
		),
	).then((result) => {
		const block = result as { block: boolean; reason: string };
		assert.equal(block.block, true);
		assert.match(block.reason, /^blocked \(20%\): /);
		assert.match(block.reason, /dirty code \(negated, satisfied 20%\)/);
	});
});

test("negate allows the edit when the failure mode is unlikely", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			rules: [{ files: "**/*.ts", checks: [{ check: "dirty code", negate: true }] }],
		}),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => jevResponse([0.05]), () =>
				toolCall(
					{
						type: "tool_call",
						toolName: "edit",
						toolCallId: "1",
						input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
					},
					ctx,
				),
			),
		),
	);
	assert.equal(result, undefined);
});

test("rule-level negate applies to its checks and per-check negate overrides it", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			rules: [
				{
					files: "**/*.ts",
					negate: true,
					checks: ["dirty code", { check: "No debug prints", negate: false }],
				},
			],
		}),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					const body = JSON.parse(String(init.body));
					assert.match(body.questions.check_0.instructions, /describes the new content: dirty code/);
					assert.match(body.questions.check_1.instructions, /satisfies this requirement: No debug prints/);
					return jevResponse([0.9, 0.9]);
				},
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "edit",
							toolCallId: "1",
							input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
						},
						ctx,
					),
			),
		),
	);
	const block = result as { block: boolean; reason: string };
	assert.equal(block.block, true);
	assert.match(block.reason, /dirty code \(negated, satisfied 10%\)/);
	assert.doesNotMatch(block.reason, /No debug prints/);
});

test("/jev-guard check marks negated checks", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			rules: [{ files: "**/*.ts", checks: [{ check: "dirty code", negate: true }] }],
		}),
		"a.ts": "foo\n",
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => jevResponse([0.2]), () => handler("check a.ts", ctx)),
		),
	);

	const report = ctx.notifications.at(-1)?.message ?? "";
	assert.match(report, /PASS\s+80%\s+dirty code\s+\[negated\]/);
});

test("sends one blob per rule with only that rule's context", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			context: "global context",
			rules: [
				{ name: "Docs", files: "**/*.md", context: "docs context", checks: ["Clear"] },
				{ name: "Any", files: "**/*", context: "all context", checks: ["Tidy"] },
			],
		}),
		"a.md": "foo\n",
	});
	const { toolCall } = harness();
	const bodies: Array<{ state: { context?: string }; questions: Record<string, unknown> }> = [];

	const result = await withEnv(CLEAN_ENV, () =>
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
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "edit",
							toolCallId: "1",
							input: { path: "a.md", edits: [{ oldText: "foo", newText: "bar" }] },
						},
						fakeContext(root),
					),
			),
		),
	);

	assert.equal(result, undefined);
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0]!.state.context, "Target file: a.md\n\nglobal context\n\ndocs context");
	assert.equal(bodies[1]!.state.context, "Target file: a.md\n\nglobal context\n\nall context");
	assert.deepEqual(Object.keys(bodies[0]!.questions), ["check_0"]);
	assert.deepEqual(Object.keys(bodies[1]!.questions), ["check_1"]);
});

test("scope both sends the whole file and the changed blocks", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ scope: "both", rules: [{ files: "**/*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				assert.equal(body.state.scope, "both");
				assert.equal(body.state.file, "a.ts");
				assert.equal(body.state.content, "bar\n");
				assert.match(body.state.change, /--- before\nfoo\n\+\+\+ after\nbar/);
				assert.match(body.questions.check_0.instructions, /complete proposed content and the edited blocks/);
				return jevResponse([0.99]);
			}, () =>
				toolCall(
					{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
					ctx,
				),
			),
		),
	);
	assert.equal(result, undefined);
});

test("scope both keeps the changed blocks when the file is truncated", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			scope: "both",
			maxFileChars: 10,
			rules: [{ files: "**/*.ts", checks: ["No bar"] }],
		}),
		"a.ts": "const value = 1;\n",
	});
	const { toolCall } = harness();

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				assert.equal(body.state.scope, "both");
				assert.match(body.state.content, /characters omitted/);
				assert.match(body.state.change, /--- before\nconst value = 1;/);
				return jevResponse([0.99]);
			}, () =>
				toolCall(
					{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] } },
					fakeContext(root),
				),
			),
		),
	);
});

test("includeFileName adds the target file to the context unless disabled", async () => {
	const rules = [{ files: "**/*.ts", checks: ["No bar"] }];
	const contexts: Array<string | undefined> = [];
	const run = (config: Record<string, unknown>) => {
		const root = makeProject({ ".jev-guard.json": JSON.stringify({ ...config, rules }), "a.ts": "foo\n" });
		const { toolCall } = harness();
		return withEnv(CLEAN_ENV, () =>
			withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
				withFetch(async (_url, init) => {
					contexts.push(JSON.parse(String(init.body)).state.context);
					return jevResponse([0.99]);
				}, () =>
					toolCall(
						{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
						fakeContext(root),
					),
				),
			),
		);
	};

	await run({ context: "global context" });
	await run({ context: "global context", includeFileName: false });
	await run({ includeFileName: false });
	assert.deepEqual(contexts, ["Target file: a.ts\n\nglobal context", "global context", undefined]);
});

test("checks the whole written content for the write tool", async () => {
	const root = makeProject({ ".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.md", checks: ["Japanese"] }] }) });
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				assert.equal(body.state.scope, "file");
				assert.equal(body.state.content, "# 日本語\n");
				assert.equal(body.state.file, "notes.md");
				return jevResponse([0.99]);
			}, () =>
				toolCall(
					{ type: "tool_call", toolName: "write", toolCallId: "1", input: { path: "notes.md", content: "# 日本語\n" } },
					ctx,
				),
			),
		),
	).then((result) => assert.equal(result, undefined));
});

test("does not call Jev when no rule matches", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.py", checks: ["No prints"] }] }),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					throw new Error("fetch should not be called");
				},
				() =>
					toolCall(
						{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
						ctx,
					),
			),
		),
	).then((result) => assert.equal(result, undefined));
});

test("ignore patterns skip matching files without calling Jev", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			ignore: ["**/__init__.py"],
			rules: [{ files: "**/*.py", checks: ["No prints"] }],
		}),
		"pkg/__init__.py": "x = 1\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					throw new Error("fetch should not be called");
				},
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "edit",
							toolCallId: "1",
							input: { path: "pkg/__init__.py", edits: [{ oldText: "x = 1", newText: "x = 2" }] },
						},
						ctx,
					),
			),
		),
	);
	assert.equal(result, undefined);
});

test("ignore supports `!` negations and basename patterns", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			ignore: ["*.py", "!keep.py"],
			rules: [{ files: "**/*.py", checks: ["No prints"] }],
		}),
		"keep.py": "print(1)\n",
		"skip.py": "print(2)\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);
	const event = (file: string) => ({
		type: "tool_call",
		toolName: "edit",
		toolCallId: "1",
		input: { path: file, edits: [{ oldText: "print", newText: "log" }] },
	});
	const calls: string[] = [];

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async (_url, init) => {
					calls.push(JSON.parse(String(init.body)).state.file);
					return jevResponse([0.99]);
				},
				async () => ({
					skipped: await toolCall(event("skip.py"), ctx),
					kept: await toolCall(event("keep.py"), ctx),
				}),
			),
		),
	);
	assert.equal(result.skipped, undefined);
	assert.equal(result.kept, undefined);
	assert.deepEqual(calls, ["keep.py"]);
});

test("an ignore in one config suppresses rules from other configs", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.py", checks: ["No prints"] }] }),
		"pkg/.jev-guard.json": JSON.stringify({ ignore: ["__init__.py"] }),
		"pkg/__init__.py": "x = 1\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root);

	const result = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					throw new Error("fetch should not be called");
				},
				() =>
					toolCall(
						{
							type: "tool_call",
							toolName: "write",
							toolCallId: "1",
							input: { path: "pkg/__init__.py", content: "x = 1\n" },
						},
						ctx,
					),
			),
		),
	);
	assert.equal(result, undefined);
});

test("ignores project configs when the project is not trusted", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
	});
	const { toolCall } = harness();
	const ctx = fakeContext(root, false);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(
				async () => {
					throw new Error("fetch should not be called");
				},
				() =>
					toolCall(
						{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
						ctx,
					),
			),
		),
	).then((result) => {
		assert.equal(result, undefined);
		assert.ok(ctx.notifications.some((entry) => entry.message.includes("not trusted")));
	});
});

test("fails open on Jev errors by default and fails closed with onError block", async () => {
	const files = {
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
	};
	const event = {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "1",
		input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
	};

	const openRoot = makeProject(files);
	const open = harness();
	const openResult = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => new Response("nope", { status: 500 }), () => open.toolCall(event, fakeContext(openRoot))),
		),
	);
	assert.equal(openResult, undefined);

	const strictRoot = makeProject({
		".jev-guard.json": JSON.stringify({ onError: "block", rules: [{ files: "**/*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
	});
	const strict = harness();
	const strictResult = await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => new Response("nope", { status: 500 }), () => strict.toolCall(event, fakeContext(strictRoot))),
		),
	);
	assert.equal((strictResult as { block: boolean }).block, true);
	assert.match((strictResult as { reason: string }).reason, /HTTP 500/);
});

test("selects the OpenRouter endpoint when only OPENROUTER_API_KEY is available", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.ts", checks: ["No bar"] }] }),
		"a.ts": "foo\n",
		".env": 'OPENROUTER_API_KEY="from-dotenv"\n',
	});
	const { toolCall } = harness();

	await withEnv(CLEAN_ENV, () =>
		withFetch(
			async (url, init) => {
				assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
				assert.equal((init.headers as Record<string, string>).authorization, "Bearer from-dotenv");
				const body = JSON.parse(String(init.body));
				assert.equal(body.model, "typesafe/jev-1.13");
				return jevResponse([0.99]);
			},
			() =>
				toolCall(
					{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
					fakeContext(root),
				),
		),
	).then((result) => assert.equal(result, undefined));
});

test("/jev-guard check reports each check", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({ rules: [{ files: "**/*.ts", checks: ["No bar", "Has a type"] }] }),
		"a.ts": "foo\n",
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () =>
		withEnv({ SYSTEMONE_API_KEY: "test-key" }, () =>
			withFetch(async () => jevResponse([0.2, 0.95]), () => handler("check a.ts", ctx)),
		),
	);

	const report = ctx.notifications.at(-1)?.message ?? "";
	assert.match(report, /FAIL\s+20%\s+No bar/);
	assert.match(report, /PASS\s+95%\s+Has a type/);
});

test("/jev-guard check reports ignored files", async () => {
	const root = makeProject({
		".jev-guard.json": JSON.stringify({
			ignore: ["**/__init__.py"],
			rules: [{ files: "**/*.py", checks: ["No prints"] }],
		}),
		"__init__.py": "x = 1\n",
	});
	const { commands } = harness();
	const ctx = fakeContext(root);
	const handler = commands.get("jev-guard");
	assert.ok(handler);

	await withEnv(CLEAN_ENV, () =>
		withFetch(
			async () => {
				throw new Error("fetch should not be called");
			},
			() => handler("check __init__.py", ctx),
		),
	);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /ignored/);
});
