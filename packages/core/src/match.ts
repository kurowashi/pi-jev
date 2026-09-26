/** Rule matching: which rules of the adopted config apply to a file. */

import * as path from "node:path";
import type {
	BaseConfig,
	BaseSettings,
	CheckSpec,
	LoadedConfig,
	MatchedRule,
	PendingCheck,
	RuleConfig,
} from "./types.ts";
import { toPosix } from "./util.ts";

/** True when the config ignores the file, so no rule applies. */
export function isIgnored<C extends BaseConfig>(config: LoadedConfig<C> | undefined, filePath: string): boolean {
	return config !== undefined && matchesFilePatterns(config.config.ignore, config.baseDir, filePath);
}

/**
 * Rules of the adopted config whose `files` patterns match the file.
 *
 * `matchAllWhenNoFiles` decides what a rule without `files` means: skip it
 * (content checks default) or apply it to every file (placement checks).
 */
/** True when the rule applies: either it has no `files` and match-all is on, or a pattern hits. */
function ruleMatches<C extends BaseConfig>(
	rule: RuleConfig,
	options: { matchAllWhenNoFiles?: boolean },
	config: LoadedConfig<C>,
	filePath: string,
): boolean {
	const noFiles = rule.files === undefined || (Array.isArray(rule.files) && rule.files.length === 0);
	if (options.matchAllWhenNoFiles === true && noFiles) return true;
	return matchesFilePatterns(rule.files, config.baseDir, filePath);
}

export function matchRules<C extends BaseConfig>(
	config: LoadedConfig<C> | undefined,
	filePath: string,
	options: { matchAllWhenNoFiles?: boolean } = {},
): MatchedRule<C>[] {
	if (!config || isIgnored(config, filePath)) return [];

	const matched: MatchedRule<C>[] = [];
	const rules = config.config.rules;
	if (!Array.isArray(rules)) return matched;
	for (const rule of rules) {
		if (!rule || typeof rule !== "object" || rule.enabled === false) continue;
		if (ruleMatches(rule, options, config, filePath)) matched.push({ rule, config });
	}
	return matched;
}

/**
 * True when the patterns match the file. Patterns without a slash match the
 * basename; `!` excludes (a later exclusion wins). At least one positive
 * pattern must match.
 */
interface PatternVerdict {
	/** Counts as a positive pattern (a later exclusion may still win). */
	positive: boolean;
	/** The pattern actually matched the target. */
	hit: boolean;
	/** A negated pattern matched, so the file is excluded. */
	excluded: boolean;
}

/** Evaluate one pattern; undefined when it is not a usable string. */
function evaluatePattern(raw: unknown, relative: string, basename: string): PatternVerdict | undefined {
	if (typeof raw !== "string") return undefined;
	const negated = raw.startsWith("!");
	const pattern = negated ? raw.slice(1) : raw;
	if (pattern.length === 0) return undefined;
	const target = pattern.includes("/") ? relative : basename;
	const hit = globToRegExp(pattern).test(target);
	return { positive: !negated, hit, excluded: negated && hit };
}

export function matchesFilePatterns(
	patterns: string | string[] | undefined,
	baseDir: string,
	filePath: string,
): boolean {
	if (patterns === undefined) return false;
	const list = Array.isArray(patterns) ? patterns : [patterns];
	const relative = toPosix(path.relative(baseDir, filePath));
	const basename = path.basename(filePath);

	let matched = false;
	let hasPositive = false;
	for (const raw of list) {
		const verdict = evaluatePattern(raw, relative, basename);
		if (!verdict) continue;
		if (verdict.excluded) return false;
		if (verdict.positive) hasPositive = true;
		if (verdict.hit) matched = true;
	}
	return hasPositive && matched;
}

/** The star-segment expansion (single, double, or double-with-slash) and its end index. */
function starSegment(pattern: string, index: number): { out: string; next: number } {
	if (pattern[index + 1] !== "*") return { out: "[^/]*", next: index };
	if (pattern[index + 2] !== "/") return { out: ".*", next: index + 1 };
	return { out: "(?:.*/)?", next: index + 2 };
}

function escapedChar(char: string): string {
	return "\\^$.|+()[]{}".includes(char) ? `\\${char}` : char;
}

/** Supports `**` (any depth), `*` (within a segment), and `?` (one character). */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern.charAt(i);
		if (char === "*") {
			const star = starSegment(pattern, i);
			out += star.out;
			i = star.next;
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += escapedChar(char);
		}
	}
	return new RegExp(`^${out}$`);
}

type NormalizedCheck = Pick<PendingCheck, "text" | "minProbability" | "negate">;

/** One check spec to its normalized form; undefined when it has no usable text. */
function normalizeCheck(spec: string | CheckSpec, rule: RuleConfig, fallback: number): NormalizedCheck | undefined {
	let text: string | undefined;
	let minProbability = typeof rule.minProbability === "number" ? rule.minProbability : fallback;
	let negate = rule.negate === true;
	if (typeof spec === "string") {
		text = spec;
	} else if (spec && typeof spec === "object") {
		const candidate = spec.check;
		if (typeof candidate === "string") text = candidate;
		if (typeof spec.minProbability === "number") minProbability = spec.minProbability;
		if (typeof spec.negate === "boolean") negate = spec.negate;
	}
	if (!text || text.trim().length === 0) return undefined;
	return { text: text.trim(), minProbability, negate };
}

/** Rule-level `minProbability` and `negate` provide the defaults for its checks. */
export function normalizeChecks(rule: RuleConfig, fallback: number): NormalizedCheck[] {
	const out: NormalizedCheck[] = [];
	if (!Array.isArray(rule.checks)) return out;
	for (const spec of rule.checks) {
		const check = normalizeCheck(spec, rule, fallback);
		if (check) out.push(check);
	}
	return out;
}

/** Flattens the matched rules into the numbered checks sent in one request. */
export function collectChecks<C extends BaseConfig>(matched: MatchedRule<C>[], fallback: number): PendingCheck<C>[] {
	const checks: PendingCheck<C>[] = [];
	let index = 0;
	for (const rule of matched) {
		for (const check of normalizeChecks(rule.rule, fallback)) {
			checks.push({ name: `check_${index++}`, ...check, rule });
		}
	}
	return checks;
}

/** All context text for the merged request: the global context first, then each rule's own. */
export function mergedContexts<C extends BaseConfig>(
	settings: Pick<BaseSettings, "context">,
	matched: MatchedRule<C>[],
): string[] {
	const parts: string[] = [];
	if (settings.context) parts.push(settings.context);
	for (const rule of matched) {
		const value = typeof rule.rule.context === "string" ? rule.rule.context.trim() : "";
		if (value.length > 0 && !parts.includes(value)) parts.push(value);
	}
	return parts;
}
