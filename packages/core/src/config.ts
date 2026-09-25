/**
 * Config discovery and resolution.
 *
 * The chain is built like AGENTS.md discovery: the target file's directory
 * first, then its parents up to the filesystem root, then the user config at
 * `~/.pi/agent/<configName>`. Nearer configs win per key; rules from every
 * level are collected.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_FILE_CHARS, DEFAULT_MIN_PROBABILITY, DEFAULT_TIMEOUT_MS } from "./constants.ts";
import type { BaseConfig, BaseSettings, LoadedConfig } from "./types.ts";
import { isInside, message, nonEmpty } from "./util.ts";

/** `~/.pi/agent/<configName>`, overridable with PI_CODING_AGENT_DIR. */
export function agentConfigPath(configName: string): string {
	const dir = nonEmpty(process.env.PI_CODING_AGENT_DIR) ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, configName);
}

export function loadConfigChain<C extends BaseConfig = BaseConfig>(
	configName: string,
	filePath: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
): LoadedConfig<C>[] {
	return loadConfigChainFromDir<C>(configName, path.dirname(filePath), cwd, trusted, warn, filePath);
}

export function loadConfigChainFromDir<C extends BaseConfig = BaseConfig>(
	configName: string,
	startDir: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
	filePath?: string,
): LoadedConfig<C>[] {
	const chain: LoadedConfig<C>[] = [];
	const insideCwd = filePath === undefined || isInside(cwd, filePath);

	const candidates: string[] = [];
	let dir = startDir;
	for (;;) {
		const file = path.join(dir, configName);
		if (fs.existsSync(file)) candidates.push(file);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	if (insideCwd && trusted) {
		for (const file of candidates) {
			const loaded = readConfigFile<C>(file, path.dirname(file), false, warn);
			if (loaded) chain.push(loaded);
		}
	} else if (candidates.length > 0) {
		warn(
			insideCwd
				? `ignoring ${candidates.join(", ")}: project is not trusted (use /trust to enable project checks)`
				: `ignoring ${candidates.join(", ")}: file is outside the working directory`,
		);
	}

	const globalFile = agentConfigPath(configName);
	if (fs.existsSync(globalFile)) {
		const loaded = readConfigFile<C>(globalFile, cwd, true, warn);
		if (loaded) chain.push(loaded);
	}
	return chain;
}

export function readConfigFile<C extends BaseConfig = BaseConfig>(
	file: string,
	baseDir: string,
	global: boolean,
	warn: (message: string) => void,
): LoadedConfig<C> | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		warn(`cannot read ${file}: ${message(error)}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		warn(`${file} is not valid JSON: ${message(error)}`);
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		warn(`${file} must contain a JSON object`);
		return undefined;
	}
	return { file, baseDir, global, config: parsed as C };
}

/** Settings every guard needs. Guards spread this and add their own keys. */
export function resolveBaseSettings<C extends BaseConfig>(chain: LoadedConfig<C>[]): BaseSettings {
	const onError = firstSetting(chain, "onError");
	return {
		enabled: firstSetting(chain, "enabled") !== false,
		endpoint: stringSetting(chain, "endpoint"),
		model: stringSetting(chain, "model"),
		apiKeyEnv: stringSetting(chain, "apiKeyEnv"),
		minProbability: numberSetting(chain, "minProbability") ?? DEFAULT_MIN_PROBABILITY,
		onError: onError === "block" ? "block" : "allow",
		includeFileName: firstSetting(chain, "includeFileName") !== false,
		maxFileChars: numberSetting(chain, "maxFileChars") ?? DEFAULT_MAX_FILE_CHARS,
		timeoutMs: numberSetting(chain, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
		fail: stringSetting(chain, "fail"),
		context: stringSetting(chain, "context"),
	};
}

/** First config in the chain that sets the key, nearest first. */
export function firstSetting<C, K extends keyof C>(chain: LoadedConfig<C>[], key: K): C[K] | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

export function stringSetting<C, K extends keyof C & string>(
	chain: LoadedConfig<C>[],
	key: K,
): string | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

export function numberSetting<C, K extends keyof C & string>(
	chain: LoadedConfig<C>[],
	key: K,
): number | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function booleanSetting<C, K extends keyof C & string>(
	chain: LoadedConfig<C>[],
	key: K,
): boolean | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

/** Accepts a single string or an array; empty and blank entries are dropped. */
export function stringListSetting<C, K extends keyof C & string>(
	chain: LoadedConfig<C>[],
	key: K,
): string[] | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) return [trimmed];
			continue;
		}
		if (Array.isArray(value)) {
			const list = value
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim());
			if (list.length > 0) return list;
		}
	}
	return undefined;
}
