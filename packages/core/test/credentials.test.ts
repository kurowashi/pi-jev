import assert from "node:assert/strict";
import test from "node:test";
import { type BaseSettings, resolveConnection } from "../src/index.ts";

const SETTINGS: BaseSettings = {
	enabled: true,
	minProbability: 0.5,
	onError: "allow",
	includeFileName: true,
	maxFileChars: 40_000,
	timeoutMs: 20_000,
};

const CLEAN_ENV = {
	SYSTEMONE_API_KEY: undefined,
	TYPESAFE_API_KEY: undefined,
	OPENROUTER_API_KEY: undefined,
	OPENCODE_API_KEY: undefined,
	OPENCODE_ZEN_API_KEY: undefined,
	COMMANDCODE_API_KEY: undefined,
	SYSTEMONE_ENDPOINT: undefined,
};

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("defaults to the TypeSafe endpoint and model", () => {
	withEnv({ ...CLEAN_ENV, SYSTEMONE_API_KEY: "k" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://api.typesafe.ai/v1/systemone");
		assert.equal(connection.model, "jev-1.13.0");
		assert.equal(connection.credential?.name, "SYSTEMONE_API_KEY");
		assert.equal(connection.error, undefined);
	});
});

test("selects OpenRouter when only OPENROUTER_API_KEY is set", () => {
	withEnv({ ...CLEAN_ENV, OPENROUTER_API_KEY: "k" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://openrouter.ai/api/alpha/decisions");
		assert.equal(connection.model, "typesafe/jev-1.13");
		assert.equal(connection.credential?.name, "OPENROUTER_API_KEY");
	});
});

test("selects OpenCode Zen when only OPENCODE_API_KEY is set", () => {
	withEnv({ ...CLEAN_ENV, OPENCODE_API_KEY: "k" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://opencode.ai/zen/v1/systemone");
		assert.equal(connection.model, "jev-1.13");
		assert.equal(connection.credential?.name, "OPENCODE_API_KEY");
		assert.equal(connection.error, undefined);
	});
});

test("accepts OPENCODE_ZEN_API_KEY as well", () => {
	withEnv({ ...CLEAN_ENV, OPENCODE_ZEN_API_KEY: "k" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://opencode.ai/zen/v1/systemone");
		assert.equal(connection.credential?.name, "OPENCODE_ZEN_API_KEY");
	});
});

test("selects Command Code when only COMMANDCODE_API_KEY is set", () => {
	withEnv({ ...CLEAN_ENV, COMMANDCODE_API_KEY: "k" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://api.commandcode.ai/provider/v1/systemone");
		assert.equal(connection.model, "typesafe/jev");
		assert.equal(connection.credential?.name, "COMMANDCODE_API_KEY");
	});
});

test("prefers OpenRouter over OpenCode when both keys are set", () => {
	withEnv({ ...CLEAN_ENV, OPENROUTER_API_KEY: "or", OPENCODE_API_KEY: "oc" }, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.endpoint, "https://openrouter.ai/api/alpha/decisions");
		assert.equal(connection.credential?.value, "or");
	});
});

test("an explicit endpoint wins and selects the model for its host", () => {
	withEnv({ ...CLEAN_ENV, OPENCODE_API_KEY: "k" }, () => {
		const connection = resolveConnection({ ...SETTINGS, endpoint: "https://opencode.ai/zen/v1/systemone" }, []);
		assert.equal(connection.model, "jev-1.13");
	});
});

test("reports a missing key for the selected host", () => {
	withEnv(CLEAN_ENV, () => {
		const connection = resolveConnection(SETTINGS, []);
		assert.equal(connection.credential, undefined);
		assert.match(connection.error ?? "", /SYSTEMONE_API_KEY/);
	});
});
