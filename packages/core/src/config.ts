/**
 * Config discovery and resolution.
 *
 * The config is found the way AGENTS.md is found: the target file's directory
 * first, then its parents up to the filesystem root. The nearest file wins and
 * is used on its own; configs are never merged and there is no user-level
 * config.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_FILE_CHARS, DEFAULT_MIN_PROBABILITY, DEFAULT_TIMEOUT_MS } from "./constants.ts";
import type { BaseConfig, BaseSettings, LoadedConfig } from "./types.ts";
import { isInside, message } from "./util.ts";

export function loadConfig<C extends BaseConfig = BaseConfig>(
	configName: string,
	filePath: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
): LoadedConfig<C> | undefined {
	return loadConfigFromDir<C>(configName, path.dirname(filePath), cwd, trusted, warn, filePath);
}

export function loadConfigFromDir<C extends BaseConfig = BaseConfig>(
	configName: string,
	startDir: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
	filePath?: string,
): LoadedConfig<C> | undefined {
	const file = findConfig(configName, startDir);
	if (!file) return undefined;

	if (filePath !== undefined && !isInside(cwd, filePath)) {
		warn(`ignoring ${file}: file is outside the working directory`);
		return undefined;
	}
	if (!trusted) {
		warn(`ignoring ${file}: project is not trusted (use /trust to enable project checks)`);
		return undefined;
	}
	return readConfigFile<C>(file, path.dirname(file), warn);
}

/** Nearest `<configName>` on the way up from `startDir` to the filesystem root. */
function findConfig(configName: string, startDir: string): string | undefined {
	let dir = startDir;
	for (;;) {
		const file = path.join(dir, configName);
		if (fs.existsSync(file)) return file;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function readConfigFile<C extends BaseConfig = BaseConfig>(
	file: string,
	baseDir: string,
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
	return { file, baseDir, config: parsed as C };
}

/** Settings every guard needs, read from the adopted config. */
export function resolveBaseSettings<C extends BaseConfig>(config: LoadedConfig<C> | undefined): BaseSettings {
	const onError = stringSetting(config, "onError");
	const timeoutSeconds = numberSetting(config, "timeoutSeconds");
	return {
		enabled: booleanSetting(config, "enabled") !== false,
		endpoint: stringSetting(config, "endpoint"),
		model: stringSetting(config, "model"),
		apiKeyEnv: stringSetting(config, "apiKeyEnv"),
		minProbability: numberSetting(config, "minProbability") ?? DEFAULT_MIN_PROBABILITY,
		onError: onError === "block" ? "block" : "allow",
		includeFileName: booleanSetting(config, "includeFileName") !== false,
		maxFileChars: numberSetting(config, "maxFileChars") ?? DEFAULT_MAX_FILE_CHARS,
		timeoutMs: timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : Math.floor(timeoutSeconds * 1000),
		fail: stringSetting(config, "fail"),
		context: stringSetting(config, "context"),
	};
}

export function stringSetting<C, K extends keyof C & string>(
	config: LoadedConfig<C> | undefined,
	key: K,
): string | undefined {
	const value = config?.config[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function numberSetting<C, K extends keyof C & string>(
	config: LoadedConfig<C> | undefined,
	key: K,
): number | undefined {
	const value = config?.config[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanSetting<C, K extends keyof C & string>(
	config: LoadedConfig<C> | undefined,
	key: K,
): boolean | undefined {
	const value = config?.config[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Accepts a single string or an array; empty and blank entries are dropped. */
export function stringListSetting<C, K extends keyof C & string>(
	config: LoadedConfig<C> | undefined,
	key: K,
): string[] | undefined {
	const value = config?.config[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : undefined;
	}
	if (Array.isArray(value)) {
		const list = value
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			.map((item) => item.trim());
		return list.length > 0 ? list : undefined;
	}
	return undefined;
}
