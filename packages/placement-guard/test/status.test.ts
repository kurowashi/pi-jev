/**
 * Integration: the /jev-placement-guard status report.
 *
 * The status is the user's only view of the resolved settings, so the values
 * that are not visible in the config file (defaults, resolved switches) are
 * pinned here.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import jevPlacementGuard from "../src/index.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function loadCommands(): Map<string, CommandHandler> {
	const commands = new Map<string, CommandHandler>();
	const pi = {
		on() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	};
	jevPlacementGuard(pi as never);
	return commands;
}

function fakeContext(cwd: string) {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify: (message: string) => void notifications.push(message) },
		},
	};
}

test("/jev-placement-guard status reports the resolved settings", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-placement-status-"));
	try {
		fs.writeFileSync(
			path.join(root, ".jev-placement-guard.json"),
			JSON.stringify({
				minProbability: 0.7,
				onError: "block",
				onlyNewFiles: false,
				timeoutSeconds: 30,
				maxFileChars: 1000,
				includeFileName: false,
			}),
		);
		const handler = loadCommands().get("jev-placement-guard");
		assert.ok(handler);
		const { ctx, notifications } = fakeContext(root);

		await handler("status", ctx);

		const report = notifications.at(-1) ?? "";
		assert.match(report, /minProbability: 0\.7/);
		assert.match(report, /onError: block/);
		assert.match(report, /timeout: 30s/);
		assert.match(report, /maxFileChars: 1000/);
		assert.match(report, /includeFileName: false/);
		assert.match(report, /fail \(top-level\): default/);
		assert.match(report, /onlyNewFiles: false/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
