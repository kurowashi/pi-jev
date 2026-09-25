/**
 * Endpoint and API-key resolution.
 *
 * Keys come from the environment first, then from the nearest `.env` while
 * walking up from the target file's directory. Which key to use depends on the
 * endpoint's host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	COMMANDCODE_ENDPOINT,
	COMMANDCODE_MODEL,
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	KEY_NAMES,
	OPENCODE_ENDPOINT,
	OPENCODE_MODEL,
	OPENROUTER_ENDPOINT,
	OPENROUTER_MODEL,
} from "./constants.ts";
import type { BaseSettings, Credential } from "./types.ts";
import { hostOf, nonEmpty } from "./util.ts";

export interface Connection {
	endpoint: string;
	model: string;
	credential?: Credential;
	error?: string;
}

/** Resolves the endpoint, model, and credential for the given search directories. */
export function resolveConnection(settings: BaseSettings, dirs: string[]): Connection {
	const keys = collectKeys(dirs);

	const endpoint = settings.endpoint ?? nonEmpty(process.env.SYSTEMONE_ENDPOINT) ?? autoEndpoint(keys);
	const host = hostOf(endpoint);
	const model = settings.model ?? defaultModelFor(host);
	const credential = pickCredential(settings, host, keys);
	return {
		endpoint,
		model,
		credential,
		error: credential ? undefined : credentialError(settings, host),
	};
}

/** TypeSafe first, then the first provider that has a key. */
function autoEndpoint(keys: Map<string, Credential>): string {
	if (keys.has("SYSTEMONE_API_KEY") || keys.has("TYPESAFE_API_KEY")) return DEFAULT_ENDPOINT;
	if (keys.has("OPENROUTER_API_KEY")) return OPENROUTER_ENDPOINT;
	if (keys.has("OPENCODE_API_KEY") || keys.has("OPENCODE_ZEN_API_KEY")) return OPENCODE_ENDPOINT;
	if (keys.has("COMMANDCODE_API_KEY")) return COMMANDCODE_ENDPOINT;
	return DEFAULT_ENDPOINT;
}

function defaultModelFor(host: string): string {
	if (host === "openrouter.ai") return OPENROUTER_MODEL;
	if (host === "opencode.ai") return OPENCODE_MODEL;
	if (host === "api.commandcode.ai") return COMMANDCODE_MODEL;
	return DEFAULT_MODEL;
}

export function collectKeys(dirs: string[]): Map<string, Credential> {
	const found = new Map<string, Credential>();
	for (const name of KEY_NAMES) {
		const value = nonEmpty(process.env[name]);
		if (value) found.set(name, { name, value, source: "environment" });
	}
	for (const dir of dirs) {
		for (const name of KEY_NAMES) {
			if (found.has(name)) continue;
			const value = readDotEnvValue(dir, name);
			if (value) found.set(name, { name, value, source: `${path.join(dir, ".env")}` });
		}
	}
	return found;
}

function pickCredential(
	settings: BaseSettings,
	host: string,
	keys: Map<string, Credential>,
): Credential | undefined {
	const order: string[] = [];
	if (settings.apiKeyEnv) order.push(settings.apiKeyEnv);
	order.push("SYSTEMONE_API_KEY");
	if (host === "api.typesafe.ai") order.push("TYPESAFE_API_KEY");
	if (host === "openrouter.ai") order.push("OPENROUTER_API_KEY");
	if (host === "opencode.ai") order.push("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY");
	if (host === "api.commandcode.ai") order.push("COMMANDCODE_API_KEY");
	for (const name of order) {
		const credential = keys.get(name);
		if (credential) return credential;
	}
	return undefined;
}

function credentialError(settings: BaseSettings, host: string): string {
	if (settings.apiKeyEnv) return `the environment variable ${settings.apiKeyEnv} is not set`;
	if (host === "api.typesafe.ai") return "no API key found; set SYSTEMONE_API_KEY or TYPESAFE_API_KEY";
	if (host === "openrouter.ai") return "no API key found; set OPENROUTER_API_KEY or SYSTEMONE_API_KEY";
	if (host === "opencode.ai") return "no API key found; set OPENCODE_API_KEY or SYSTEMONE_API_KEY";
	if (host === "api.commandcode.ai") return "no API key found; set COMMANDCODE_API_KEY or SYSTEMONE_API_KEY";
	return `no API key found for ${host || "the configured endpoint"}; set SYSTEMONE_API_KEY or add "apiKeyEnv"`;
}

/** Nearest `.env` on the way up from `startDir` that defines `name`, if any. */
export function readDotEnvValue(startDir: string, name: string): string | undefined {
	let dir = startDir;
	for (;;) {
		const value = parseDotEnv(path.join(dir, ".env"))[name];
		if (value) return value;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Minimal `.env` reader: KEY=value, optional `export`, quotes, and ` #` comments. */
export function parseDotEnv(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return out;
	}
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1]!;
		let value = match[2]!.trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		} else {
			const comment = value.indexOf(" #");
			if (comment >= 0) value = value.slice(0, comment).trim();
		}
		if (value.length > 0) out[key] = value;
	}
	return out;
}
