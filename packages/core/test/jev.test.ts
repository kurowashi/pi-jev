/**
 * The Jev HTTP call: request assembly, answer parsing, and the error taxonomy
 * (fetch failures, HTTP hints, and malformed payloads).
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callJev, describeFetchError, type JevRequest, statusHint } from "../src/jev.ts";
import { collectChecks } from "../src/match.ts";
import type { LoadedConfig, RuleConfig } from "../src/types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(): JevRequest {
	const rule: RuleConfig = { name: "R", checks: ["The requirement holds."] };
	const config: LoadedConfig = { file: "/cfg/.jev.json", baseDir: "/cfg", config: { rules: [rule] } };
	return {
		endpoint: "https://jev.example.test",
		model: "jev-1",
		apiKey: "secret",
		state: "the state document",
		describeState: "the file",
		subject: "new content",
		checks: collectChecks([{ rule, config }], 0.5),
		timeoutMs: 1000,
	};
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
	calls: Array<{ url: string; init: RequestInit }>;
} {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return handler(call.url, call.init);
	}) as typeof fetch;
	return { calls };
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("callJev sends the questions and returns probabilities", async () => {
	const { calls } = stubFetch(() => jsonResponse({ answers: { check_0: { noul: 0.87 } } }));
	const outcome = await callJev(request());

	assert.equal(outcome.ok, true);
	assert.equal(outcome.ok && outcome.probabilities.get("check_0"), 0.87);
	const body = JSON.parse(String(calls[0]?.init.body)) as {
		model: string;
		state: string;
		questions: Record<string, { type: string; instructions: string }>;
	};
	assert.equal(body.model, "jev-1");
	assert.equal(body.state, "the state document");
	assert.equal(body.questions["check_0"]?.type, "noul");
	assert.match(body.questions["check_0"]?.instructions ?? "", /The requirement holds\./);
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), "Bearer secret");
});

test("callJev rejects a payload without answers or without a numeric answer", async () => {
	stubFetch(() => jsonResponse({}));
	const missing = await callJev(request());
	assert.equal(missing.ok, false);
	assert.match(missing.ok === false ? missing.message : "", /without answers/);

	stubFetch(() => jsonResponse({ answers: { check_0: { noul: "high" } } }));
	const nonNumeric = await callJev(request());
	assert.equal(nonNumeric.ok, false);
	assert.match(nonNumeric.ok === false ? nonNumeric.message : "", /did not answer the check/);
});

test("callJev reports HTTP failures with a status hint", async () => {
	stubFetch(() => jsonResponse({}, 429));
	const outcome = await callJev(request());
	assert.equal(outcome.ok, false);
	assert.match(outcome.ok === false ? outcome.message : "", /HTTP 429 \(rate limited\)/);
});

test("callJev reports a non-JSON response", async () => {
	stubFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
	const outcome = await callJev(request());
	assert.equal(outcome.ok, false);
	assert.match(outcome.ok === false ? outcome.message : "", /not JSON/);
});

test("callJev reports a fetch failure", async () => {
	stubFetch(() => Promise.reject(new Error("connection refused")));
	const outcome = await callJev(request());
	assert.equal(outcome.ok, false);
	assert.match(outcome.ok === false ? outcome.message : "", /connection refused/);
});

test("describeFetchError distinguishes timeouts from other failures", () => {
	const timeout = new Error("t");
	timeout.name = "TimeoutError";
	assert.equal(describeFetchError(timeout, 2500), "Jev did not answer within 2500 ms.");
	const abort = new Error("a");
	abort.name = "AbortError";
	assert.equal(describeFetchError(abort, 1000), "Jev did not answer within 1000 ms.");
	assert.match(describeFetchError(new Error("boom"), 1000), /Jev request failed: boom/);
});

test("statusHint covers every documented status family", () => {
	assert.match(statusHint(400), /token budget/);
	assert.match(statusHint(401), /API key/);
	assert.match(statusHint(403), /API key/);
	assert.match(statusHint(402), /payment/);
	assert.match(statusHint(404), /endpoint/);
	assert.match(statusHint(405), /endpoint/);
	assert.match(statusHint(410), /endpoint/);
	assert.match(statusHint(408), /timed out/);
	assert.match(statusHint(429), /rate limited/);
	assert.match(statusHint(503), /service unavailable/);
	assert.equal(statusHint(200), "");
});
