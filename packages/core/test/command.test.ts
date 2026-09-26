/**
 * The shared command dispatcher: subcommand routing, state toggling, and the
 * output helpers every guard reuses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CommandHandlers, clippedText, contextLines, displayBlock, runCommand } from "../src/command.ts";
import type { LoadedConfig } from "../src/types.ts";

interface Notify {
	message: string;
	type: string | undefined;
}

function commandContext(): { ctx: ExtensionCommandContext; notifications: Notify[] } {
	const notifications: Notify[] = [];
	const ctx = {
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

function spec(handlers: Partial<CommandHandlers> = {}): { handlers: CommandHandlers; calls: string[] } {
	const calls: string[] = [];
	const full: CommandHandlers = {
		status: () => calls.push("status"),
		init: () => calls.push("init"),
		check: async (arg) => {
			calls.push(`check:${arg}`);
		},
		context: (arg) => calls.push(`context:${arg}`),
		help: () => "usage text",
		...handlers,
	};
	return { handlers: full, calls };
}

function state(enabled = true): {
	state: { isEnabled(): boolean; setEnabled(value: boolean): void };
	enabled: () => boolean;
} {
	let value = enabled;
	return {
		state: {
			isEnabled: () => value,
			setEnabled: (next: boolean) => {
				value = next;
			},
		},
		enabled: () => value,
	};
}

test("an empty argument and `status` both run the status handler", async () => {
	const { ctx } = commandContext();
	const status = spec();
	const toggle = state();
	await runCommand("", ctx, toggle.state, { name: "g", switchLabel: "checks", handlers: status.handlers });
	await runCommand("status", ctx, toggle.state, { name: "g", switchLabel: "checks", handlers: status.handlers });
	assert.deepEqual(status.calls, ["status", "status"]);
});

test("init, check, and context dispatch with their arguments", async () => {
	const { ctx } = commandContext();
	const handlers = spec();
	const toggle = state();
	await runCommand("init", ctx, toggle.state, { name: "g", switchLabel: "checks", handlers: handlers.handlers });
	await runCommand("check src/a.ts  --json", ctx, toggle.state, {
		name: "g",
		switchLabel: "checks",
		handlers: handlers.handlers,
	});
	await runCommand("context .", ctx, toggle.state, { name: "g", switchLabel: "checks", handlers: handlers.handlers });
	assert.deepEqual(handlers.calls, ["init", "check:src/a.ts --json", "context:."]);
});

test("on and off toggle the state and notify with the label", async () => {
	const { ctx, notifications } = commandContext();
	const handlers = spec();
	const toggle = state(false);
	const commandSpec = { name: "jev-x", switchLabel: "checks", handlers: handlers.handlers };

	await runCommand("on", ctx, toggle.state, commandSpec);
	assert.equal(toggle.enabled(), true);
	assert.deepEqual(notifications.at(-1), { message: "jev-x: checks enabled", type: "info" });

	await runCommand("off", ctx, toggle.state, commandSpec);
	assert.equal(toggle.enabled(), false);
	assert.deepEqual(notifications.at(-1), { message: "jev-x: checks disabled for this session", type: "info" });
});

test("unknown subcommands fall back to the help text", async () => {
	const { ctx, notifications } = commandContext();
	const handlers = spec();
	const toggle = state();
	await runCommand("frobnicate", ctx, toggle.state, {
		name: "g",
		switchLabel: "checks",
		handlers: handlers.handlers,
	});
	assert.deepEqual(notifications.at(-1), { message: "usage text", type: "info" });
	assert.deepEqual(handlers.calls, []);
});

test("contextLines describes the config or says there is none", () => {
	assert.deepEqual(contextLines(undefined), ["context: (none)"]);
	const empty: LoadedConfig = { file: "/cfg/.x.json", baseDir: "/cfg", config: {} };
	assert.deepEqual(contextLines(empty), ["context: (none)"]);
	const filled: LoadedConfig = {
		file: "/cfg/.x.json",
		baseDir: "/cfg",
		config: { context: "global context" },
	};
	assert.deepEqual(contextLines(filled), ["context (from /cfg/.x.json):", "----", "global context", "----"]);
});

test("clippedText keeps short text and truncates long text with a pointer", () => {
	assert.equal(clippedText("short", "/x context"), "short");
	const long = "a".repeat(30);
	const clipped = clippedText(long, "/x context", 10);
	assert.match(clipped, /^a{10}\n\.\.\. \(20 characters omitted; run \/x context <file> for the full state\)$/);
});

test("displayBlock fences the text", () => {
	assert.deepEqual(displayBlock("a\nb"), ["----", "a", "b", "----"]);
});
