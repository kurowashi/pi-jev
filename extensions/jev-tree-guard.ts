/**
 * jev-tree-guard — semantic placement checks for newly created files, backed by TypeSafe Jev (System One).
 *
 * Hooks the `write` tool. When the target path does not exist yet, the extension
 * renders the existing project tree (bounded and ignore-aware), attaches the
 * proposed file content, and asks Jev whether the new file belongs where it is
 * being added. A failed check blocks the write and returns the rule's `fail`
 * text to the model.
 *
 * Project configs (`.jev-tree-guard.json`) apply only inside the trusted working
 * directory. The user config at `~/.pi/agent/jev-tree-guard.json` always applies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------

const CONFIG_NAME = ".jev-tree-guard.json";
const AGENT_DIR = nonEmpty(process.env.PI_CODING_AGENT_DIR) ?? path.join(os.homedir(), ".pi", "agent");
const GLOBAL_CONFIG_PATH = path.join(AGENT_DIR, `jev-tree-guard.json`);
const STATUS_KEY = "jev-tree-guard";
const CONTEXT_COMMAND = "/jev-tree-guard context";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_MODEL = "typesafe/jev-1.13";

const DEFAULT_MIN_PROBABILITY = 0.5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FILE_CHARS = 40_000;
const DEFAULT_MAX_TREE_ENTRIES = 400;
const DEFAULT_MAX_TREE_DEPTH = 5;

export const DEFAULT_TREE_IGNORE = [
	"**/.git/**",
	"**/.svn/**",
	"**/.hg/**",
	"**/node_modules/**",
	"**/.venv/**",
	"**/venv/**",
	"**/__pycache__/**",
	"**/.mypy_cache/**",
	"**/.pytest_cache/**",
	"**/.ruff_cache/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/target/**",
	"**/vendor/**",
	"**/.next/**",
	"**/.cache/**",
	"**/.pi/tasks/**",
	"**/coverage/**",
];

const KEY_NAMES = [
	"SYSTEMONE_API_KEY",
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
	"OPENCODE_API_KEY",
	"OPENCODE_ZEN_API_KEY",
	"COMMANDCODE_API_KEY",
];

type OnError = "allow" | "block";
type PlacementKind = "new file" | "overwrite";

// ------------------------------------------------------------------------------------------------
// Config shape
// ------------------------------------------------------------------------------------------------

interface CheckSpec {
	/** The requirement to check. `question` is accepted as an alias. */
	check?: string;
	question?: string;
	/** Minimum probability of "yes" for the check to pass. */
	minProbability?: number;
	/**
	 * Set to true when `check` names the failure mode instead of the requirement.
	 * Jev answers the statement as written and the probability is inverted.
	 */
	negate?: boolean;
}

interface RuleConfig {
	/** Label used in `{rule}` and failure output. */
	name?: string;
	/** Set to false to disable a rule without deleting it. */
	enabled?: boolean;
	/**
	 * Glob(s) relative to the config file's directory, matched against the new
	 * file's path. No slash matches the basename. Prefix with `!` to exclude.
	 * Omitted or empty matches every file.
	 */
	files?: string | string[];
	/** Requirements Jev answers yes/no for. */
	checks?: Array<string | CheckSpec>;
	/** Message returned to the model when a check fails. Supports {file} {rule} {checks} {probability}. */
	fail?: string;
	/** Extra context sent to Jev only with this rule's own request (blob). */
	context?: string;
	/** Default minProbability for this rule's checks. */
	minProbability?: number;
	/** Default negate for this rule's checks. */
	negate?: boolean;
}

interface HookConfig {
	enabled?: boolean;
	endpoint?: string;
	model?: string;
	apiKeyEnv?: string;
	minProbability?: number;
	onError?: OnError;
	/** Include the target file's name in the context sent to Jev (default true). */
	includeFileName?: boolean;
	/** Truncate the proposed content sent to Jev. */
	maxFileChars?: number;
	timeoutMs?: number;
	fail?: string;
	/** Extra context sent to Jev with every request (all rules). */
	context?: string;
	/** Glob(s) relative to the config file's directory; matching files are never checked. */
	ignore?: string | string[];
	/** Check only files that do not exist yet (default true). */
	onlyNewFiles?: boolean;
	/** Send the proposed file content along with the tree (default true). */
	includeContent?: boolean;
	/** Maximum number of tree entries sent to Jev (default 400). */
	maxTreeEntries?: number;
	/** Maximum directory depth of the tree (default 5). */
	maxTreeDepth?: number;
	/** Glob(s) hidden from the tree. Defaults to common build/vendor directories. */
	treeIgnore?: string | string[];
	rules?: RuleConfig[];
}

interface LoadedConfig {
	file: string;
	/** Directory that `files` patterns are relative to. */
	baseDir: string;
	global: boolean;
	config: HookConfig;
}

interface ResolvedSettings {
	enabled: boolean;
	endpoint?: string;
	model?: string;
	apiKeyEnv?: string;
	minProbability: number;
	onError: OnError;
	includeFileName: boolean;
	maxFileChars: number;
	timeoutMs: number;
	fail?: string;
	context?: string;
	onlyNewFiles: boolean;
	includeContent: boolean;
	maxTreeEntries: number;
	maxTreeDepth: number;
	treeIgnore: string[];
}

interface MatchedRule {
	rule: RuleConfig;
	config: LoadedConfig;
}

interface PendingCheck {
	name: string;
	text: string;
	minProbability: number;
	negate: boolean;
	rule: MatchedRule;
}

interface Credential {
	name: string;
	value: string;
	source: string;
}

interface ProposedPlacement {
	file: string;
	kind: PlacementKind;
	tree: string;
	content?: string;
	note?: string;
	/** Local-only diagnostics; not part of the state sent to Jev. */
	treeEntries: number;
	treeTruncated: boolean;
}

type JevOutcome =
	| { ok: true; probabilities: Map<string, number> }
	| { ok: false; message: string };

// ------------------------------------------------------------------------------------------------
// Extension entry point
// ------------------------------------------------------------------------------------------------

export default function jevTreeGuard(pi: ExtensionAPI): void {
	let sessionEnabled = true;

	pi.on("session_start", () => {
		sessionEnabled = true;
		warned.clear();
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!sessionEnabled || disabledByEnv()) return undefined;
		if (event.toolName !== "write") return undefined;

		const input = event.input as Record<string, unknown>;
		const rawPath = input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
		if (typeof input.content !== "string") return undefined;

		const absPath = path.resolve(ctx.cwd, rawPath);
		const display = displayPath(absPath, ctx.cwd);
		const warn = (message: string) => warnOnce(ctx, message);

		if (!isInside(ctx.cwd, absPath)) {
			warn(`skipping ${display}: the file is outside the working directory, so no project tree is available`);
			return undefined;
		}

		const isNew = !fs.existsSync(absPath);

		const chain = loadConfigChain(absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
		if (chain.length === 0) return undefined;

		const settings = resolveSettings(chain);
		if (!settings.enabled) return undefined;
		if (!isNew && settings.onlyNewFiles) return undefined;
		if (isIgnored(chain, absPath)) return undefined;

		const matched = matchRules(chain, absPath);
		const checks = collectChecks(matched, settings.minProbability);
		if (checks.length === 0) return undefined;

		const targetRel = toPosix(path.relative(ctx.cwd, absPath));
		const proposed = buildPlacementState({
			file: display,
			kind: isNew ? "new file" : "overwrite",
			root: ctx.cwd,
			targetRel,
			content: input.content,
			settings,
		});
		const contexts = mergedContexts(settings, matched);

		const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
		if (!connection.credential) {
			return handleCheckError(settings, ctx, connection.error ?? "No Jev API key found.", display);
		}

		ctx.ui.setStatus(STATUS_KEY, `jev: checking placement ${display}`);
		let outcome: JevOutcome;
		try {
			outcome = await callJev({
				endpoint: connection.endpoint,
				model: connection.model,
				apiKey: connection.credential.value,
				proposed,
				contexts,
				includeFileName: settings.includeFileName,
				checks,
				timeoutMs: settings.timeoutMs,
			});
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		if (!outcome.ok) {
			return handleCheckError(settings, ctx, outcome.message, display);
		}

		const failures = checks.filter(
			(check) =>
				satisfiedProbability(check, outcome.probabilities.get(check.name) ?? 0) < check.minProbability,
		);
		if (failures.length === 0) return undefined;

		ctx.ui.notify(`jev-tree-guard: blocked ${display} (${failures.length} check(s) failed)`, "warning");
		return { block: true, reason: buildFailureReason(failures, outcome.probabilities, settings, display) };
	});

	const commandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		await handleCommand(args, ctx, {
			isEnabled: () => sessionEnabled,
			setEnabled: (value: boolean) => {
				sessionEnabled = value;
			},
		});
	};

	pi.registerCommand("jev-tree-guard", {
		description: "Show, initialize, or dry-run .jev-tree-guard.json placement checks",
		handler: commandHandler,
	});
	pi.registerCommand("jev-tree", {
		description: "Alias of /jev-tree-guard",
		handler: commandHandler,
	});
}

// ------------------------------------------------------------------------------------------------
// Config discovery
// ------------------------------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(ctx: ExtensionContext, message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	ctx.ui.notify(`jev-tree-guard: ${message}`, "warning");
}

function loadConfigChain(
	filePath: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
): LoadedConfig[] {
	return loadConfigChainFromDir(path.dirname(filePath), cwd, trusted, warn, filePath);
}

function loadConfigChainFromDir(
	startDir: string,
	cwd: string,
	trusted: boolean,
	warn: (message: string) => void,
	filePath?: string,
): LoadedConfig[] {
	const chain: LoadedConfig[] = [];
	const insideCwd = filePath === undefined || isInside(cwd, filePath);

	const candidates: string[] = [];
	let dir = startDir;
	for (;;) {
		const file = path.join(dir, CONFIG_NAME);
		if (fs.existsSync(file)) candidates.push(file);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	if (insideCwd && trusted) {
		for (const file of candidates) {
			const loaded = readConfigFile(file, path.dirname(file), false, warn);
			if (loaded) chain.push(loaded);
		}
	} else if (candidates.length > 0) {
		warn(
			insideCwd
				? `ignoring ${candidates.join(", ")}: project is not trusted (use /trust to enable project checks)`
				: `ignoring ${candidates.join(", ")}: file is outside the working directory`,
		);
	}

	if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
		const loaded = readConfigFile(GLOBAL_CONFIG_PATH, cwd, true, warn);
		if (loaded) chain.push(loaded);
	}
	return chain;
}

function readConfigFile(
	file: string,
	baseDir: string,
	global: boolean,
	warn: (message: string) => void,
): LoadedConfig | undefined {
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
	return { file, baseDir, global, config: parsed as HookConfig };
}

function resolveSettings(chain: LoadedConfig[]): ResolvedSettings {
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
		onlyNewFiles: booleanSetting(chain, "onlyNewFiles") ?? true,
		includeContent: booleanSetting(chain, "includeContent") ?? true,
		maxTreeEntries: numberSetting(chain, "maxTreeEntries") ?? DEFAULT_MAX_TREE_ENTRIES,
		maxTreeDepth: numberSetting(chain, "maxTreeDepth") ?? DEFAULT_MAX_TREE_DEPTH,
		treeIgnore: stringListSetting(chain, "treeIgnore") ?? DEFAULT_TREE_IGNORE,
	};
}

function firstSetting<K extends keyof HookConfig>(chain: LoadedConfig[], key: K): HookConfig[K] | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

function stringSetting(chain: LoadedConfig[], key: keyof HookConfig): string | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function numberSetting(chain: LoadedConfig[], key: keyof HookConfig): number | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function booleanSetting(chain: LoadedConfig[], key: keyof HookConfig): boolean | undefined {
	for (const entry of chain) {
		const value = entry.config[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function stringListSetting(chain: LoadedConfig[], key: keyof HookConfig): string[] | undefined {
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

// ------------------------------------------------------------------------------------------------
// Rule matching
// ------------------------------------------------------------------------------------------------

/** True when any config in the chain ignores the file, so no rule applies. */
function isIgnored(chain: LoadedConfig[], filePath: string): boolean {
	return chain.some((config) => {
		const patterns = config.config.ignore;
		if (patterns === undefined) return false;
		if (Array.isArray(patterns) && patterns.length === 0) return false;
		return matchesFilePatterns(patterns, config.baseDir, filePath);
	});
}

function matchRules(chain: LoadedConfig[], filePath: string): MatchedRule[] {
	if (isIgnored(chain, filePath)) return [];

	const matched: MatchedRule[] = [];
	for (const config of chain) {
		const rules = config.config.rules;
		if (!Array.isArray(rules)) continue;
		for (const rule of rules) {
			if (!rule || typeof rule !== "object" || rule.enabled === false) continue;
			const matchesAll = rule.files === undefined || (Array.isArray(rule.files) && rule.files.length === 0);
			if (matchesAll || matchesFilePatterns(rule.files, config.baseDir, filePath)) {
				matched.push({ rule, config });
			}
		}
	}
	return matched;
}

function matchesFilePatterns(
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
		if (typeof raw !== "string") continue;
		const negated = raw.startsWith("!");
		const pattern = negated ? raw.slice(1) : raw;
		if (pattern.length === 0) continue;
		if (!negated) hasPositive = true;
		const target = pattern.includes("/") ? relative : basename;
		if (globToRegExp(pattern).test(target)) {
			if (negated) return false;
			matched = true;
		}
	}
	return hasPositive && matched;
}

/** Supports `**` (any depth), `*` (within a segment), and `?` (one character). */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(char)) {
			out += `\\${char}`;
		} else {
			out += char;
		}
	}
	return new RegExp(`^${out}$`);
}

type NormalizedCheck = Pick<PendingCheck, "text" | "minProbability" | "negate">;

function normalizeChecks(rule: RuleConfig, fallback: number): NormalizedCheck[] {
	const out: NormalizedCheck[] = [];
	if (!Array.isArray(rule.checks)) return out;
	for (const spec of rule.checks) {
		let text: string | undefined;
		let minProbability = typeof rule.minProbability === "number" ? rule.minProbability : fallback;
		let negate = rule.negate === true;
		if (typeof spec === "string") {
			text = spec;
		} else if (spec && typeof spec === "object") {
			const candidate = spec.check ?? spec.question;
			if (typeof candidate === "string") text = candidate;
			if (typeof spec.minProbability === "number") minProbability = spec.minProbability;
			if (typeof spec.negate === "boolean") negate = spec.negate;
		}
		if (text && text.trim().length > 0) out.push({ text: text.trim(), minProbability, negate });
	}
	return out;
}

function collectChecks(matched: MatchedRule[], fallback: number): PendingCheck[] {
	const checks: PendingCheck[] = [];
	let index = 0;
	for (const rule of matched) {
		for (const check of normalizeChecks(rule.rule, fallback)) {
			checks.push({ name: `check_${index++}`, ...check, rule });
		}
	}
	return checks;
}

/** All context text for the merged request: the global context first, then each rule's own. */
function mergedContexts(settings: ResolvedSettings, matched: MatchedRule[]): string[] {
	const parts: string[] = [];
	if (settings.context) parts.push(settings.context);
	for (const rule of matched) {
		const value = typeof rule.rule.context === "string" ? rule.rule.context.trim() : "";
		if (value.length > 0 && !parts.includes(value)) parts.push(value);
	}
	return parts;
}

/**
 * Formats the Jev state as one document: the merged context, the target path,
 * the project tree, and the proposed file content.
 */
function buildStateDocument(
	proposed: ProposedPlacement,
	contexts: string[],
	includeFileName: boolean,
): string {
	const sections: string[] = [];
	if (contexts.length > 0) sections.push(contexts.join("\n\n"));
	if (includeFileName) {
		sections.push(`file: ${proposed.file} (${proposed.kind === "new file" ? "new" : "overwrite"})`);
	}
	sections.push(`project tree\n${fenced(proposed.tree)}`);
	if (proposed.content !== undefined) sections.push(`file content\n${fenced(proposed.content)}`);
	if (proposed.note) sections.push(`note: ${proposed.note}`);
	return sections.join("\n\n");
}

function fenced(text: string, language = ""): string {
	return `\`\`\`${language}\n${text.replace(/\n+$/, "")}\n\`\`\``;
}

// ------------------------------------------------------------------------------------------------
// Project tree rendering
// ------------------------------------------------------------------------------------------------

export interface TreeRenderOptions {
	/** Maximum number of entries rendered (default 400). */
	maxEntries?: number;
	/** Maximum directory depth (default 5). Directories on the target file's path are always descended. */
	maxDepth?: number;
	/** Glob(s) relative to `root` hidden from the tree. Prefix with `!` to un-ignore. */
	ignore?: string[];
	/** Relative path hidden from the listing (used when dry-running an existing file as if it were new). */
	exclude?: string;
}

export interface RenderedTree {
	text: string;
	entries: number;
	directories: number;
	files: number;
	truncated: boolean;
	/** Directory that would contain the target file, relative to the root ("." for the root). */
	focusDir: string;
	/** Directories that do not exist yet and would be created, relative to the root. */
	createdDirs: string[];
}

/**
 * Renders a bounded, ignore-aware view of the existing tree rooted at `root`.
 * The target file is marked `(new)` inside its directory, and missing
 * directories on its path are marked `(new dir)`. The path to the target is
 * always rendered even when the entry budget or depth limit is reached.
 */
export function renderTree(root: string, targetRel: string, options: TreeRenderOptions = {}): RenderedTree {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_TREE_ENTRIES;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_TREE_DEPTH;
	const ignore = options.ignore ?? [];
	const exclude = options.exclude === undefined ? undefined : normalizeRel(options.exclude);

	const target = normalizeRel(targetRel);
	const targetName = path.posix.basename(target);
	const focusDir = normalizeRel(path.posix.dirname(target));

	const lines: string[] = ["./"];
	const createdDirs: string[] = [];
	let entries = 0;
	let directories = 0;
	let files = 0;
	let truncated = false;

	const onFocusPath = (rel: string): boolean =>
		rel === "." || focusDir === rel || focusDir.startsWith(`${rel}/`);

	const isIgnoredPath = (rel: string, isDir: boolean): boolean => {
		let ignored = false;
		for (const raw of ignore) {
			if (typeof raw !== "string" || raw.length === 0) continue;
			const negated = raw.startsWith("!");
			const pattern = negated ? raw.slice(1) : raw;
			if (pattern.length === 0) continue;
			const targetPath = pattern.includes("/") ? rel : path.posix.basename(rel);
			const regexp = globToRegExp(pattern);
			const hit = regexp.test(targetPath) || (isDir && regexp.test(`${targetPath}/`));
			if (!hit) continue;
			if (negated) return false;
			ignored = true;
		}
		return ignored;
	};

	const walk = (dirRel: string, depth: number): void => {
		const dirAbs = dirRel === "." ? root : path.join(root, dirRel);
		let dirents: fs.Dirent[] = [];
		try {
			dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			dirents = [];
		}

		const dirs: Array<{ name: string; virtual?: boolean }> = [];
		const items: Array<{ name: string; virtual?: boolean }> = [];
		for (const dirent of dirents) {
			const rel = dirRel === "." ? dirent.name : `${dirRel}/${dirent.name}`;
			if (exclude !== undefined && rel === exclude) continue;
			if (dirent.isDirectory()) {
				if (!isIgnoredPath(rel, true)) dirs.push({ name: dirent.name });
			} else if (dirent.isFile() || dirent.isSymbolicLink()) {
				if (!isIgnoredPath(rel, false)) items.push({ name: dirent.name });
			}
		}

		if (onFocusPath(dirRel) && dirRel !== focusDir) {
			const rest = dirRel === "." ? focusDir : focusDir.slice(dirRel.length + 1);
			const next = rest.split("/")[0] ?? "";
			if (next.length > 0 && !dirs.some((dir) => dir.name === next)) {
				dirs.unshift({ name: next, virtual: true });
				createdDirs.push(dirRel === "." ? next : `${dirRel}/${next}`);
			}
		}
		if (dirRel === focusDir && !items.some((item) => item.name === targetName)) {
			items.unshift({ name: targetName, virtual: true });
		}

		const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
		dirs.sort((a, b) => Number(Boolean(b.virtual)) - Number(Boolean(a.virtual)) || byName(a, b));
		items.sort((a, b) => Number(Boolean(b.virtual)) - Number(Boolean(a.virtual)) || byName(a, b));

		const indent = "  ".repeat(depth + 1);
		for (const dir of dirs) {
			const rel = dirRel === "." ? dir.name : `${dirRel}/${dir.name}`;
			const focus = onFocusPath(rel);
			if (entries >= maxEntries && !dir.virtual && !focus) {
				truncated = true;
				continue;
			}
			entries++;
			directories++;
			lines.push(`${indent}${dir.name}/${dir.virtual ? " (new dir)" : ""}`);
			if (dir.virtual || depth + 1 < maxDepth || focus) walk(rel, depth + 1);
		}
		for (const item of items) {
			if (entries >= maxEntries && !item.virtual) {
				truncated = true;
				continue;
			}
			entries++;
			files++;
			lines.push(`${indent}${item.name}${item.virtual ? " (new)" : ""}`);
		}
	};

	walk(".", 0);
	return { text: lines.join("\n"), entries, directories, files, truncated, focusDir, createdDirs };
}

// ------------------------------------------------------------------------------------------------
// Proposed placement state
// ------------------------------------------------------------------------------------------------

interface PlacementInput {
	file: string;
	kind: PlacementKind;
	root: string;
	targetRel: string;
	content?: string;
	exclude?: string;
	settings: ResolvedSettings;
}

function buildPlacementState(input: PlacementInput): ProposedPlacement {
	const rendered = renderTree(input.root, input.targetRel, {
		maxEntries: input.settings.maxTreeEntries,
		maxDepth: input.settings.maxTreeDepth,
		ignore: input.settings.treeIgnore,
		exclude: input.exclude,
	});

	const limited =
		input.settings.includeContent && input.content !== undefined
			? limitText(input.content, input.settings.maxFileChars)
			: undefined;

	const notes: string[] = [];
	if (limited?.note) notes.push(limited.note);
	if (rendered.createdDirs.length > 0) {
		notes.push(`These directories do not exist yet and would be created: ${rendered.createdDirs.join(", ")}.`);
	}

	return {
		file: input.file,
		kind: input.kind,
		tree: rendered.text,
		content: limited?.text,
		note: notes.length > 0 ? notes.join(" ") : undefined,
		treeEntries: rendered.entries,
		treeTruncated: rendered.truncated,
	};
}

function limitText(text: string, max: number): { text: string; note?: string } {
	if (text.length <= max) return { text };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	return {
		text: `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`,
		note: "The content was truncated in the middle to stay within maxFileChars.",
	};
}

// ------------------------------------------------------------------------------------------------
// Jev request
// ------------------------------------------------------------------------------------------------

interface JevRequest {
	endpoint: string;
	model: string;
	apiKey: string;
	proposed: ProposedPlacement;
	contexts: string[];
	includeFileName: boolean;
	checks: PendingCheck[];
	timeoutMs: number;
}

/** One request per tool call: every matching rule's checks and context are merged. */
async function callJev(request: JevRequest): Promise<JevOutcome> {
	const state = buildStateDocument(request.proposed, request.contexts, request.includeFileName);
	const questions: Record<string, unknown> = {};
	for (const check of request.checks) {
		const ask = check.negate
			? `Answer yes if the following statement describes the new file: ${check.text}`
			: `Answer yes if the new file satisfies this requirement: ${check.text}`;
		questions[check.name] = {
			type: "noul",
			instructions: `The state contains ${describePlacementState(request.proposed, request.includeFileName)}. ${ask}`,
			criteria: check.negate
				? { true: "The statement describes the new file.", false: "The statement does not describe the new file." }
				: { true: "The requirement is satisfied.", false: "The requirement is violated." },
		};
	}

	let response: Response;
	try {
		response = await fetch(request.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${request.apiKey}`,
			},
			body: JSON.stringify({ model: request.model, state, questions }),
			signal: AbortSignal.timeout(request.timeoutMs),
		});
	} catch (error) {
		return { ok: false, message: describeFetchError(error, request.timeoutMs) };
	}

	if (!response.ok) {
		return { ok: false, message: `Jev returned HTTP ${response.status}${statusHint(response.status)}` };
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { ok: false, message: "Jev returned a response that is not JSON." };
	}

	const answers = (payload as { answers?: Record<string, { noul?: unknown }> } | null)?.answers;
	if (!answers || typeof answers !== "object") {
		return { ok: false, message: "Jev returned a response without answers." };
	}

	const probabilities = new Map<string, number>();
	for (const check of request.checks) {
		const value = answers[check.name]?.noul;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return { ok: false, message: `Jev did not answer the check "${check.text}".` };
		}
		probabilities.set(check.name, value);
	}
	return { ok: true, probabilities };
}

function describePlacementState(state: ProposedPlacement, includeFileName: boolean): string {
	const parts: string[] = [];
	if (includeFileName) {
		parts.push(
			state.kind === "new file" ? "the path of the file being added" : "the path of the file being overwritten",
		);
	}
	parts.push(
		state.kind === "new file"
			? 'an existing project file tree in which "(new)" marks the file being added and "(new dir)" marks a directory that would be created'
			: "an existing project file tree in which the file being overwritten is already present",
	);
	if (state.content !== undefined && state.content.length > 0) parts.push("the proposed content of the file");
	return parts.join(", ");
}

function describeFetchError(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `Jev did not answer within ${timeoutMs} ms.`;
	}
	return `Jev request failed: ${message(error)}`;
}

function statusHint(status: number): string {
	if (status === 401 || status === 403) return " (check the API key)";
	if (status === 402) return " (payment required)";
	if (status === 404 || status === 405 || status === 410) return " (check the endpoint URL)";
	if (status === 408) return " (request timed out)";
	if (status === 429) return " (rate limited)";
	if (status >= 500) return " (service unavailable)";
	return "";
}

// ------------------------------------------------------------------------------------------------
// Credentials and endpoint
// ------------------------------------------------------------------------------------------------

interface Connection {
	endpoint: string;
	model: string;
	credential?: Credential;
	error?: string;
}

function resolveConnection(settings: ResolvedSettings, dirs: string[]): Connection {
	const keys = collectKeys(dirs);

	let endpoint = settings.endpoint ?? nonEmpty(process.env.SYSTEMONE_ENDPOINT);
	if (!endpoint) {
		const hasTypesafe = keys.has("SYSTEMONE_API_KEY") || keys.has("TYPESAFE_API_KEY");
		endpoint = !hasTypesafe && keys.has("OPENROUTER_API_KEY") ? OPENROUTER_ENDPOINT : DEFAULT_ENDPOINT;
	}
	const host = hostOf(endpoint);
	const model = settings.model ?? (host === "openrouter.ai" ? OPENROUTER_MODEL : DEFAULT_MODEL);
	const credential = pickCredential(settings, host, keys);
	return {
		endpoint,
		model,
		credential,
		error: credential ? undefined : credentialError(settings, host),
	};
}

function collectKeys(dirs: string[]): Map<string, Credential> {
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
	settings: ResolvedSettings,
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

function credentialError(settings: ResolvedSettings, host: string): string {
	if (settings.apiKeyEnv) return `the environment variable ${settings.apiKeyEnv} is not set`;
	if (host === "api.typesafe.ai") return "no API key found; set SYSTEMONE_API_KEY or TYPESAFE_API_KEY";
	if (host === "openrouter.ai") return "no API key found; set OPENROUTER_API_KEY or SYSTEMONE_API_KEY";
	return `no API key found for ${host || "the configured endpoint"}; set SYSTEMONE_API_KEY or add "apiKeyEnv"`;
}

function readDotEnvValue(startDir: string, name: string): string | undefined {
	let dir = startDir;
	for (;;) {
		const value = parseDotEnv(path.join(dir, ".env"))[name];
		if (value) return value;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

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

// ------------------------------------------------------------------------------------------------
// Failure output
// ------------------------------------------------------------------------------------------------

function handleCheckError(
	settings: ResolvedSettings,
	ctx: ExtensionContext,
	message: string,
	display: string,
): ToolCallEventResult | undefined {
	if (settings.onError === "block") {
		ctx.ui.notify(`jev-tree-guard: ${message}`, "error");
		return {
			block: true,
			reason: `Jev placement check could not run for ${display}: ${message}.\nSet "onError": "allow" in ${CONFIG_NAME} to let writes through when Jev is unavailable.`,
		};
	}
	warnOnce(ctx, `${message} (write allowed)`);
	return undefined;
}

/**
 * Probability that a check's requirement is satisfied. A negated check states
 * the failure mode, so Jev's probability of the statement is inverted.
 */
function satisfiedProbability(check: PendingCheck, raw: number): number {
	return check.negate ? 1 - raw : raw;
}

function buildFailureReason(
	failures: PendingCheck[],
	probabilities: Map<string, number>,
	settings: ResolvedSettings,
	file: string,
): string {
	const byRule = new Map<MatchedRule, PendingCheck[]>();
	for (const failure of failures) {
		const list = byRule.get(failure.rule) ?? [];
		list.push(failure);
		byRule.set(failure.rule, list);
	}

	const blocks: string[] = [];
	for (const [rule, list] of byRule) {
		const details = list
			.map((check) => {
				const probability = satisfiedProbability(check, probabilities.get(check.name) ?? 0);
				return `- ${check.text} (${check.negate ? "negated, " : ""}satisfied ${percent(probability)})`;
			})
			.join("\n");
		const template = rule.rule.fail ?? settings.fail;
		if (template) {
			blocks.push(
				renderTemplate(template, {
					file,
					rule: ruleLabel(rule),
					checks: details,
					details,
					probability: percent(
						Math.min(
							...list.map((check) =>
								satisfiedProbability(check, probabilities.get(check.name) ?? 0),
							),
						),
					),
				}),
			);
		} else {
			blocks.push(
				`Jev placement check failed for ${file}:\n${details}\nChoose a directory or file name that fits the existing tree, then retry the write.`,
			);
		}
	}
	return blocks.join("\n\n");
}

export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function percent(probability: number): string {
	return `${Math.round(probability * 100)}%`;
}

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------

interface CommandState {
	isEnabled(): boolean;
	setEnabled(value: boolean): void;
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, state: CommandState): Promise<void> {
	const [sub = "", ...rest] = args.trim().split(/\s+/);
	switch (sub) {
		case "":
		case "status":
			showStatus(ctx, state);
			return;
		case "init":
			initConfig(ctx);
			return;
		case "check":
			await dryRun(rest.join(" "), ctx);
			return;
		case "context":
			showContext(rest.join(" "), ctx);
			return;
		case "on":
			state.setEnabled(true);
			ctx.ui.notify("jev-tree-guard: placement checks enabled", "info");
			return;
		case "off":
			state.setEnabled(false);
			ctx.ui.notify("jev-tree-guard: placement checks disabled for this session", "info");
			return;
		default:
			ctx.ui.notify(helpText(), "info");
	}
}

function helpText(): string {
	return [
		"/jev-tree-guard             show status",
		"/jev-tree-guard init        write a starter .jev-tree-guard.json in the working directory",
		"/jev-tree-guard check FILE  check a path as if it were about to be created, without writing it",
		"/jev-tree-guard context [FILE]  show the merged context and the state sent to Jev",
		"/jev-tree-guard on | off    enable or disable checks for this session",
	].join("\n");
}

function showStatus(ctx: ExtensionCommandContext, state: CommandState): void {
	const chain = loadConfigChainFromDir(ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), () => {});
	const settings = resolveSettings(chain);
	const connection = resolveConnection(settings, uniqueDirs([ctx.cwd]));
	const ruleCount = (entry: LoadedConfig) => (Array.isArray(entry.config.rules) ? entry.config.rules.length : 0);

	const lines = [
		`jev-tree-guard: ${state.isEnabled() && settings.enabled ? "on" : "off"}`,
		`configs: ${chain.length === 0 ? "none" : ""}`.trimEnd(),
		...chain.map((entry) => `  ${entry.file} — ${ruleCount(entry)} rule(s)`),
		`endpoint: ${connection.endpoint}`,
		`model: ${connection.model}`,
		`key: ${connection.credential ? `${connection.credential.name} (${connection.credential.source})` : connection.error}`,
		`onlyNewFiles: ${settings.onlyNewFiles}`,
		`includeContent: ${settings.includeContent}`,
		`tree: maxEntries=${settings.maxTreeEntries} maxDepth=${settings.maxTreeDepth} ignore=${settings.treeIgnore.length} pattern(s)`,
		"",
		helpText(),
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

function initConfig(ctx: ExtensionCommandContext): void {
	const target = path.join(ctx.cwd, CONFIG_NAME);
	if (fs.existsSync(target)) {
		ctx.ui.notify(`jev-tree-guard: ${target} already exists`, "warning");
		return;
	}

	const keys = collectKeys(uniqueDirs([ctx.cwd]));
	const starter: HookConfig = {
		enabled: true,
		minProbability: DEFAULT_MIN_PROBABILITY,
		onError: "allow",
		onlyNewFiles: true,
		includeContent: true,
		context:
			"Describe this project's directory layout, naming conventions, and where new files belong. This text is sent to Jev with every check.",
		rules: [
			{
				name: "Placement",
				files: ["**/*"],
				checks: [
					"Is the new file placed in the directory that best matches its purpose in the existing project structure?",
					"Is the new file grouped with related files rather than placed in an unrelated directory?",
					"Is the new file's name consistent with the naming conventions of the existing files?",
					{ check: "Does the new file duplicate or overlap with an existing file?", negate: true },
					{ check: "Does the new file introduce a new directory without a clear reason?", negate: true },
				],
				fail: [
					"Jev placement check failed for {file}:",
					"{checks}",
					"Choose a directory or file name that fits the existing tree, then retry the write.",
				].join("\n"),
			},
		],
	};
	if (!keys.has("SYSTEMONE_API_KEY") && !keys.has("TYPESAFE_API_KEY") && keys.has("OPENROUTER_API_KEY")) {
		starter.endpoint = OPENROUTER_ENDPOINT;
		starter.model = OPENROUTER_MODEL;
		starter.apiKeyEnv = "OPENROUTER_API_KEY";
	}

	try {
		fs.writeFileSync(target, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
	} catch (error) {
		ctx.ui.notify(`jev-tree-guard: could not write ${target}: ${message(error)}`, "error");
		return;
	}
	ctx.ui.notify(`jev-tree-guard: wrote ${target}. Edit the rules, then run /jev-tree-guard check <file>.`, "info");
}

async function dryRun(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const target = arg.trim();
	if (target.length === 0) {
		ctx.ui.notify("usage: /jev-tree-guard check <file>", "warning");
		return;
	}

	const absPath = path.resolve(ctx.cwd, target);
	const display = displayPath(absPath, ctx.cwd);
	if (!isInside(ctx.cwd, absPath)) {
		ctx.ui.notify(`jev-tree-guard: ${display} is outside the working directory`, "warning");
		return;
	}

	const targetRel = toPosix(path.relative(ctx.cwd, absPath));
	let content: string | undefined;
	try {
		if (!fs.statSync(absPath).isFile()) throw new Error("not a file");
		content = fs.readFileSync(absPath, "utf8");
	} catch {
		content = undefined;
	}

	const chain = loadConfigChain(absPath, ctx.cwd, ctx.isProjectTrusted(), (warning) =>
		ctx.ui.notify(`jev-tree-guard: ${warning}`, "warning"),
	);
	const settings = resolveSettings(chain);
	if (isIgnored(chain, absPath)) {
		ctx.ui.notify(`jev-tree-guard: ${display} is ignored by ${CONFIG_NAME}`, "info");
		return;
	}

	const matched = matchRules(chain, absPath);
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) {
		ctx.ui.notify(`jev-tree-guard: no rules match ${display}`, "warning");
		return;
	}

	const proposed = buildPlacementState({
		file: display,
		kind: "new file",
		root: ctx.cwd,
		targetRel,
		content,
		exclude: targetRel,
		settings,
	});
	const contexts = mergedContexts(settings, matched);

	const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
	if (!connection.credential) {
		ctx.ui.notify(`jev-tree-guard: ${connection.error ?? "no API key"}`, "error");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `jev: checking placement ${display}`);
	let outcome: JevOutcome;
	try {
		outcome = await callJev({
			endpoint: connection.endpoint,
			model: connection.model,
			apiKey: connection.credential.value,
			proposed,
			contexts,
			includeFileName: settings.includeFileName,
			checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	if (!outcome.ok) {
		ctx.ui.notify(`jev-tree-guard: ${outcome.message}`, "error");
		return;
	}

	const lines = checks.map((check) => {
		const probability = satisfiedProbability(check, outcome.probabilities.get(check.name) ?? 0);
		const verdict = probability >= check.minProbability ? "PASS" : "FAIL";
		const suffix = check.negate ? "  [negated]" : "";
		return `${verdict}  ${percent(probability).padStart(4)}  ${check.text}${suffix}`;
	});
	ctx.ui.notify(
		[
			`jev-tree-guard check: ${display}${content === undefined ? " (not created yet)" : ""}`,
			`endpoint: ${connection.endpoint}`,
			`model: ${connection.model}`,
			`tree: ${proposed.treeEntries} entries${proposed.treeTruncated ? " (truncated)" : ""}`,
			"",
			...lines,
			"",
			"state sent to Jev:",
			...displayBlock(clippedText(buildStateDocument(proposed, contexts, settings.includeFileName))),
		].join("\n"),
		"info",
	);
}

/**
 * Shows the context and the exact state document a check would send to Jev,
 * without calling Jev. With a file it resolves the merged request; without a
 * file it shows the global context of each config.
 */
function showContext(arg: string, ctx: ExtensionCommandContext): void {
	const target = arg.trim();
	const absPath = target.length > 0 ? path.resolve(ctx.cwd, target) : undefined;
	if (absPath !== undefined && !isInside(ctx.cwd, absPath)) {
		ctx.ui.notify(`jev-tree-guard: ${displayPath(absPath, ctx.cwd)} is outside the working directory`, "warning");
		return;
	}

	const display = absPath === undefined ? undefined : displayPath(absPath, ctx.cwd);
	const warn = (warning: string) => ctx.ui.notify(`jev-tree-guard: ${warning}`, "warning");
	const chain =
		absPath === undefined
			? loadConfigChainFromDir(ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), warn)
			: loadConfigChain(absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
	const settings = resolveSettings(chain);
	const ruleCount = (entry: LoadedConfig) => (Array.isArray(entry.config.rules) ? entry.config.rules.length : 0);

	const lines: string[] = [
		display === undefined ? "jev-tree-guard context" : `jev-tree-guard context: ${display}`,
		`configs: ${chain.length === 0 ? "none" : ""}`.trimEnd(),
		...chain.map((entry) => `  ${entry.file} — ${ruleCount(entry)} rule(s)`),
		`enabled: ${settings.enabled}   onlyNewFiles: ${settings.onlyNewFiles}   includeFileName: ${settings.includeFileName}`,
		"",
		...globalContextLines(chain),
	];

	if (display === undefined || absPath === undefined) {
		lines.push("", `Rules need a target file: run ${CONTEXT_COMMAND} <file> to see the merged request state.`);
	} else {
		lines.push(
			`file line: ${settings.includeFileName ? `file: ${display} (new)` : "(disabled by includeFileName: false)"}`,
			"",
		);
		if (isIgnored(chain, absPath)) {
			lines.push(`ignored by ${CONFIG_NAME}: no Jev request is sent for this file.`);
		} else {
			const sending = matchRules(chain, absPath).filter(
				(rule) => normalizeChecks(rule.rule, settings.minProbability).length > 0,
			);
			if (sending.length === 0) {
				lines.push("no checks apply to this file: no Jev request is sent.");
			} else {
				const contexts = mergedContexts(settings, sending);
				lines.push(
					`rules merged into one request: ${sending.length} — ${sending.map((rule) => ruleLabel(rule)).join(", ")}`,
				);
				if (contexts.length === 0) {
					lines.push("merged context: (none)");
				} else {
					lines.push(`merged context (${contexts.length} part(s)):`, ...displayBlock(contexts.join("\n\n")));
				}

				let content: string | undefined;
				try {
					if (fs.statSync(absPath).isFile()) content = fs.readFileSync(absPath, "utf8");
				} catch {
					// The file does not exist yet: show the tree and path without content.
				}
				const targetRel = toPosix(path.relative(ctx.cwd, absPath));
				const proposed = buildPlacementState({
					file: display,
					kind: "new file",
					root: ctx.cwd,
					targetRel,
					content,
					exclude: targetRel,
					settings,
				});
				lines.push(
					`tree: ${proposed.treeEntries} entries${proposed.treeTruncated ? " (truncated)" : ""}`,
					"",
					"state sent to Jev (as a new file):",
					...displayBlock(buildStateDocument(proposed, contexts, settings.includeFileName)),
				);
			}
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/** Global context values from the chain, marking the first (effective) one. */
function globalContextLines(chain: LoadedConfig[]): string[] {
	const sources = chain
		.map((entry) => ({ file: entry.file, value: entry.config.context }))
		.filter(
			(entry): entry is { file: string; value: string } =>
				typeof entry.value === "string" && entry.value.trim().length > 0,
		);
	if (sources.length === 0) return ["global context: (none)"];
	const lines: string[] = [];
	for (const [index, source] of sources.entries()) {
		const shadowed = index === 0 ? "" : ` [shadowed by ${sources[0]!.file}]`;
		lines.push(`global context (from ${source.file})${shadowed}:`, ...displayBlock(source.value.trim()));
	}
	return lines;
}

/** Caps a long state document for command output and points at the full-text command. */
function clippedText(text: string, max = 2000): string {
	if (text.length <= max) return text;
	const omitted = text.length - max;
	return `${text.slice(0, max)}\n... (${omitted} characters omitted; run ${CONTEXT_COMMAND} <file> for the full state)`;
}

function displayBlock(text: string): string[] {
	return ["----", ...text.split(/\r?\n/), "----"];
}

function ruleLabel(rule: MatchedRule): string {
	return rule.rule.name ?? path.basename(rule.config.file);
}

// ------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------

function disabledByEnv(): boolean {
	const value = process.env.JEV_TREE_GUARD_DISABLE;
	return value === "1" || value === "true";
}

function displayPath(absPath: string, cwd: string): string {
	const relative = path.relative(cwd, absPath);
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return absPath;
	return toPosix(relative);
}

function isInside(dir: string, filePath: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueDirs(dirs: string[]): string[] {
	return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function normalizeRel(value: string): string {
	const posix = toPosix(value).replace(/\/+$/, "").replace(/^\.\//, "");
	return posix.length === 0 ? "." : posix;
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "";
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
