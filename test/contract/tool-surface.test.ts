/**
 * Contract: both guards are hook-only extensions.
 *
 * A registered tool is re-sent to the model on every request; these guards act
 * on tool calls that already happen, so their model-facing surface must stay
 * empty. Commands and event handlers are the user-facing and behavior surface
 * and are pinned here too, because dropping one silently disables a promise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARD_DIRS, loadGuard } from "../helpers/loader.ts";

/** The only event pair either guard needs. */
const EXPECTED_EVENTS = ["session_start", "tool_call"];

test("neither guard registers a model-facing tool", async () => {
	for (const dir of GUARD_DIRS) {
		const extension = await loadGuard(dir);
		assert.deepEqual([...extension.tools.keys()], [], `${dir} must stay hook-only`);
	}
});

test("each guard registers its command and exactly the expected events", async () => {
	const contentGuard = await loadGuard("packages/content-guard");
	assert.deepEqual([...contentGuard.commands.keys()], ["jev-content-guard"]);
	assert.deepEqual([...contentGuard.handlers.keys()].sort(), EXPECTED_EVENTS);

	const placementGuard = await loadGuard("packages/placement-guard");
	assert.deepEqual([...placementGuard.commands.keys()], ["jev-placement-guard"]);
	assert.deepEqual([...placementGuard.handlers.keys()].sort(), EXPECTED_EVENTS);
});
