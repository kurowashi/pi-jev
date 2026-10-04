/**
 * jev-placement-guard — semantic placement checks for newly created files, backed by TypeSafe Jev (System One).
 *
 * Hooks the `write` tool. When the target path does not exist yet, the extension
 * renders the existing project tree (bounded and ignore-aware), attaches the
 * proposed file content, and asks Jev whether the new file belongs where it is
 * being added. A failed check blocks the write and returns the rule's `fail`
 * text to the model.
 *
 * The nearest `.jev-placement-guard.json` on the way up to the filesystem root is
 * used, and only inside the trusted working directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
	BaseConfig,
	BaseSettings,
	CommandState,
	GuardFlavor,
	JevOutcome,
	LoadedConfig,
	PendingCheck,
} from "@pi-jev/core";
import {
	booleanSetting,
	buildFailureReason,
	callJev,
	clippedText,
	collectChecks,
	collectKeys,
	contextLines,
	createWarnOnce,
	DEFAULT_MIN_PROBABILITY,
	disabledByEnv,
	displayBlock,
	displayPath,
	fenced,
	globToRegExp,
	handleCheckError,
	isIgnored,
	isInside,
	limitText,
	loadConfig,
	loadConfigFromDir,
	matchRules,
	mergedContexts,
	message,
	normalizeChecks,
	numberSetting,
	OPENROUTER_ENDPOINT,
	OPENROUTER_MODEL,
	percent,
	resolveBaseSettings,
	resolveConnection,
	ruleLabel,
	runCommand,
	satisfiedProbability,
	stringListSetting,
	toPosix,
	uniqueDirs,
} from "@pi-jev/core";

// Re-exported for the tests that exercise the shared helpers.
export { globToRegExp, parseDotEnv, renderTemplate } from "@pi-jev/core";

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------

const NAME = "jev-placement-guard";
const CONFIG_NAME = ".jev-placement-guard.json";
const STATUS_KEY = "jev-placement-guard";
const CONTEXT_COMMAND = "/jev-placement-guard context";

/** Messages core renders on this guard's behalf. */
const FLAVOR: GuardFlavor = {
	name: NAME,
	configName: CONFIG_NAME,
	checkLabel: "Jev placement check",
	action: "write",
};

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

type PlacementKind = "new file" | "overwrite";

// ------------------------------------------------------------------------------------------------
// Config shape
// ------------------------------------------------------------------------------------------------

interface HookConfig extends BaseConfig {
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
}

interface ResolvedSettings extends BaseSettings {
	onlyNewFiles: boolean;
	includeContent: boolean;
	maxTreeEntries: number;
	maxTreeDepth: number;
	treeIgnore: string[];
}
interface ProposedPlacement {
	file: string;
	kind: PlacementKind;
	tree: string;
	content?: string | undefined;
	note?: string | undefined;
	/** Diagnostics for the command output; the note tells Jev when the tree was cut off. */
	treeEntries: number;
	treeTruncated: boolean;
	treeDepthLimited: boolean;
}

/** The resolved target for a checked write, or undefined when the call is out of scope. */
function checkedTarget(
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
): { absPath: string; display: string; content: string } | undefined {
	if (event.toolName !== "write") return undefined;
	const input = event.input as Record<string, unknown>;
	const rawPath = input["path"];
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	const content = input["content"];
	if (typeof content !== "string") return undefined;
	const absPath = path.resolve(ctx.cwd, rawPath);
	return { absPath, display: displayPath(absPath, ctx.cwd), content };
}

/** The config, checks, contexts, and proposed state for one in-scope write. */
interface PreparedPlacement {
	settings: ResolvedSettings;
	checks: PendingCheck<HookConfig>[];
	contexts: string[];
	proposed: ProposedPlacement;
}

function preparePlacement(
	target: { absPath: string; display: string; content: string },
	ctx: ExtensionContext,
	warn: (message: string) => void,
): PreparedPlacement | undefined {
	if (!isInside(ctx.cwd, target.absPath)) {
		warn(`skipping ${target.display}: the file is outside the working directory, so no project tree is available`);
		return undefined;
	}
	const isNew = !fs.existsSync(target.absPath);
	const config = loadConfig<HookConfig>(CONFIG_NAME, target.absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
	if (!config) return undefined;
	const settings = resolveSettings(config);
	if (!settings.enabled) return undefined;
	if (!isNew && settings.onlyNewFiles) return undefined;
	if (isIgnored(config, target.absPath)) return undefined;
	const matched = matchRules(config, target.absPath, { matchAllWhenNoFiles: true });
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) return undefined;
	const targetRel = toPosix(path.relative(ctx.cwd, target.absPath));
	const proposed = buildPlacementState({
		file: target.display,
		kind: isNew ? "new file" : "overwrite",
		root: ctx.cwd,
		targetRel,
		content: target.content,
		settings,
	});
	return { settings, checks, contexts: mergedContexts(settings, matched), proposed };
}

/** The checks whose probability is below their threshold. */
function placementFailures(
	checks: PendingCheck<HookConfig>[],
	probabilities: Map<string, number>,
): PendingCheck<HookConfig>[] {
	return checks.filter(
		(check) => satisfiedProbability(check, probabilities.get(check.name) ?? 0) < check.minProbability,
	);
}

/** The blocked result with the failure text for the model. */
function placementBlocked(
	failures: PendingCheck<HookConfig>[],
	probabilities: Map<string, number>,
	settings: ResolvedSettings,
	display: string,
	ctx: ExtensionContext,
): ToolCallEventResult {
	ctx.ui.notify(`${NAME}: blocked ${display} (${failures.length} check(s) failed)`, "warning");
	return {
		block: true,
		reason: buildFailureReason(
			failures,
			probabilities,
			settings,
			display,
			(file, details) =>
				`Jev placement check failed for ${file}:\n${details}\nChoose a directory or file name that fits the existing tree, then retry the write.`,
		),
	};
}

/** Resolve the connection, call Jev, and turn the verdict into a tool result. */
async function runPlacementCheck(
	prepared: PreparedPlacement,
	absPath: string,
	display: string,
	ctx: ExtensionContext,
	warn: (message: string) => void,
): Promise<ToolCallEventResult | undefined> {
	const { settings, checks, contexts, proposed } = prepared;
	const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
	const credential = connection.credential;
	if (!credential) {
		return handleCheckError(settings, ctx, FLAVOR, connection.error ?? "No Jev API key found.", display, warn);
	}
	ctx.ui.setStatus(STATUS_KEY, `jev: checking placement ${display}`);
	let outcome: JevOutcome;
	try {
		outcome = await callJev({
			endpoint: connection.endpoint,
			model: connection.model,
			apiKey: credential.value,
			state: buildStateDocument(proposed, contexts, settings.includeFileName),
			describeState: describePlacementState(proposed, settings.includeFileName),
			subject: proposed.kind === "new file" ? "new file" : "the file being overwritten",
			checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
	if (!outcome.ok) return handleCheckError(settings, ctx, FLAVOR, outcome.message, display, warn);
	const failures = placementFailures(checks, outcome.probabilities);
	if (failures.length === 0) return undefined;
	return placementBlocked(failures, outcome.probabilities, settings, display, ctx);
}

// ------------------------------------------------------------------------------------------------
// Extension entry point
// ------------------------------------------------------------------------------------------------

export default function jevTreeGuard(pi: ExtensionAPI): void {
	let sessionEnabled = true;

	pi.on("session_start", () => {
		sessionEnabled = true;
		warnings.reset();
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!sessionEnabled || disabledByEnv("JEV_PLACEMENT_GUARD_DISABLE")) return undefined;
		const target = checkedTarget(event, ctx);
		if (!target) return undefined;
		const warn = (message: string) => warnings.warn(ctx, message);
		const prepared = preparePlacement(target, ctx, warn);
		if (!prepared) return undefined;
		return await runPlacementCheck(prepared, target.absPath, target.display, ctx, warn);
	});

	const commandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		await runCommand(
			args,
			ctx,
			{
				isEnabled: () => sessionEnabled,
				setEnabled: (value: boolean) => {
					sessionEnabled = value;
				},
			},
			{
				name: NAME,
				switchLabel: "placement checks",
				handlers: {
					status: showStatus,
					init: initConfig,
					check: dryRun,
					context: showContext,
					help: helpText,
				},
			},
		);
	};

	pi.registerCommand("jev-placement-guard", {
		description: "Show, initialize, or dry-run .jev-placement-guard.json placement checks",
		handler: commandHandler,
	});
}

// ------------------------------------------------------------------------------------------------
// Session state
// ------------------------------------------------------------------------------------------------

/** Warnings are reported once per session, prefixed with the guard name. */
const warnings = createWarnOnce(NAME);

/** Number of rules declared by a config, shown in status and context output. */
function ruleCount(config: LoadedConfig): number {
	return Array.isArray(config.config.rules) ? config.config.rules.length : 0;
}

function resolveSettings(config: LoadedConfig<HookConfig> | undefined): ResolvedSettings {
	return {
		...resolveBaseSettings(config),
		onlyNewFiles: booleanSetting(config, "onlyNewFiles") ?? true,
		includeContent: booleanSetting(config, "includeContent") ?? true,
		maxTreeEntries: numberSetting(config, "maxTreeEntries") ?? DEFAULT_MAX_TREE_ENTRIES,
		maxTreeDepth: numberSetting(config, "maxTreeDepth") ?? DEFAULT_MAX_TREE_DEPTH,
		treeIgnore: stringListSetting(config, "treeIgnore") ?? DEFAULT_TREE_IGNORE,
	};
}

/**
 * Formats the Jev state as one document: the merged context, the target path,
 * the project tree, and the proposed file content.
 */
function buildStateDocument(proposed: ProposedPlacement, contexts: string[], includeFileName: boolean): string {
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

// ------------------------------------------------------------------------------------------------
// Project tree rendering
// ------------------------------------------------------------------------------------------------

export interface TreeRenderOptions {
	/** Maximum number of entries rendered (default 400). */
	maxEntries?: number | undefined;
	/** Maximum directory depth (default 5). Directories on the target file's path are always descended. */
	maxDepth?: number | undefined;
	/** Glob(s) relative to `root` hidden from the tree. Prefix with `!` to un-ignore. */
	ignore?: string[] | undefined;
	/** Relative path hidden from the listing (used when dry-running an existing file as if it were new). */
	exclude?: string | undefined;
}

export interface RenderedTree {
	text: string;
	entries: number;
	directories: number;
	files: number;
	truncated: boolean;
	/** True when a directory was not descended into because `maxDepth` was reached. */
	depthLimited: boolean;
	/** Directory that would contain the target file, relative to the root ("." for the root). */
	focusDir: string;
	/** Directories that do not exist yet and would be created, relative to the root. */
	createdDirs: string[];
}

interface TreeEntry {
	name: string;
	virtual?: boolean;
}

/** Read a directory, treating an unreadable one as empty. */
function readDirents(dirAbs: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirAbs, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** One ignore pattern: true ignores, false re-includes, undefined does not match. */
function ignoreVerdict(raw: unknown, rel: string, isDir: boolean): boolean | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	const negated = raw.startsWith("!");
	const pattern = negated ? raw.slice(1) : raw;
	if (pattern.length === 0) return undefined;
	const targetPath = pattern.includes("/") ? rel : path.posix.basename(rel);
	const regexp = globToRegExp(pattern);
	const hit = regexp.test(targetPath) || (isDir && regexp.test(`${targetPath}/`));
	if (!hit) return undefined;
	return !negated;
}

/** Ignore globs with `!` re-includes; a later match wins. */
function pathIgnored(rel: string, isDir: boolean, ignore: string[]): boolean {
	let ignored = false;
	for (const raw of ignore) {
		const verdict = ignoreVerdict(raw, rel, isDir);
		if (verdict === undefined) continue;
		if (!verdict) return false;
		ignored = true;
	}
	return ignored;
}

/** The visible dirs and files of one directory. */
function visibleEntry(
	dirRel: string,
	dirent: fs.Dirent,
	options: { exclude: string | undefined; ignore: string[] },
): { kind: "dir" | "item"; name: string } | undefined {
	const rel = dirRel === "." ? dirent.name : `${dirRel}/${dirent.name}`;
	if (options.exclude !== undefined && rel === options.exclude) return undefined;
	if (dirent.isDirectory()) {
		return pathIgnored(rel, true, options.ignore) ? undefined : { kind: "dir", name: dirent.name };
	}
	if (!dirent.isFile() && !dirent.isSymbolicLink()) return undefined;
	return pathIgnored(rel, false, options.ignore) ? undefined : { kind: "item", name: dirent.name };
}

/** The visible dirs and files of one directory. */
function visibleChildren(
	dirRel: string,
	dirents: fs.Dirent[],
	options: { exclude: string | undefined; ignore: string[] },
): { dirs: TreeEntry[]; items: TreeEntry[] } {
	const dirs: TreeEntry[] = [];
	const items: TreeEntry[] = [];
	for (const dirent of dirents) {
		const entry = visibleEntry(dirRel, dirent, options);
		if (!entry) continue;
		if (entry.kind === "dir") dirs.push({ name: entry.name });
		else items.push({ name: entry.name });
	}
	return { dirs, items };
}

/** Virtual (new) entries first, then alphabetical. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
	return Number(Boolean(b.virtual)) - Number(Boolean(a.virtual)) || a.name.localeCompare(b.name);
}

/** Mutable state of one tree walk; module scope keeps each helper's complexity isolated. */
interface TreeWalk {
	root: string;
	exclude: string | undefined;
	ignore: string[];
	maxEntries: number;
	maxDepth: number;
	focusDir: string;
	targetName: string;
	lines: string[];
	createdDirs: string[];
	entries: number;
	directories: number;
	files: number;
	truncated: boolean;
	depthLimited: boolean;
}

function onFocusPath(state: TreeWalk, rel: string): boolean {
	return rel === "." || state.focusDir === rel || state.focusDir.startsWith(`${rel}/`);
}

function addVirtualDir(state: TreeWalk, dirRel: string, dirs: TreeEntry[]): void {
	const rest = dirRel === "." ? state.focusDir : state.focusDir.slice(dirRel.length + 1);
	const next = rest.split("/")[0] ?? "";
	if (next.length === 0 || dirs.some((dir) => dir.name === next)) return;
	dirs.unshift({ name: next, virtual: true });
	state.createdDirs.push(dirRel === "." ? next : `${dirRel}/${next}`);
}

function addVirtualFile(state: TreeWalk, dirRel: string, items: TreeEntry[]): void {
	if (dirRel === state.focusDir && !items.some((item) => item.name === state.targetName)) {
		items.unshift({ name: state.targetName, virtual: true });
	}
}

function emitItem(state: TreeWalk, item: TreeEntry, indent: string): void {
	if (state.entries >= state.maxEntries && !item.virtual) {
		state.truncated = true;
		return;
	}
	state.entries++;
	state.files++;
	state.lines.push(`${indent}${item.name}${item.virtual ? " (new)" : ""}`);
}

function emitDir(state: TreeWalk, dirRel: string, depth: number, dir: TreeEntry, indent: string): void {
	const rel = dirRel === "." ? dir.name : `${dirRel}/${dir.name}`;
	const focus = onFocusPath(state, rel);
	if (state.entries >= state.maxEntries && !dir.virtual && !focus) {
		state.truncated = true;
		return;
	}
	state.entries++;
	state.directories++;
	state.lines.push(`${indent}${dir.name}/${dir.virtual ? " (new dir)" : ""}`);
	const descend = dir.virtual === true || depth + 1 < state.maxDepth || focus;
	if (!descend) {
		state.depthLimited = true;
		return;
	}
	walkTree(state, rel, depth + 1);
}

function walkTree(state: TreeWalk, dirRel: string, depth: number): void {
	const dirAbs = dirRel === "." ? state.root : path.join(state.root, dirRel);
	const { dirs, items } = visibleChildren(dirRel, readDirents(dirAbs), {
		exclude: state.exclude,
		ignore: state.ignore,
	});
	if (onFocusPath(state, dirRel) && dirRel !== state.focusDir) addVirtualDir(state, dirRel, dirs);
	if (dirRel === state.focusDir) addVirtualFile(state, dirRel, items);
	dirs.sort(compareTreeEntries);
	items.sort(compareTreeEntries);
	const indent = "  ".repeat(depth + 1);
	for (const dir of dirs) emitDir(state, dirRel, depth, dir, indent);
	for (const item of items) emitItem(state, item, indent);
}

/**
 * Renders a bounded, ignore-aware view of the existing tree rooted at `root`.
 * The target file is marked `(new)` inside its directory, and missing
 * directories on its path are marked `(new dir)`. The path to the target is
 * always rendered even when the entry budget or depth limit is reached.
 */
export function renderTree(root: string, targetRel: string, options: TreeRenderOptions = {}): RenderedTree {
	const target = normalizeRel(targetRel);
	const state: TreeWalk = {
		root,
		exclude: options.exclude === undefined ? undefined : normalizeRel(options.exclude),
		ignore: options.ignore ?? [],
		maxEntries: options.maxEntries ?? DEFAULT_MAX_TREE_ENTRIES,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_TREE_DEPTH,
		focusDir: normalizeRel(path.posix.dirname(target)),
		targetName: path.posix.basename(target),
		lines: ["./"],
		createdDirs: [],
		entries: 0,
		directories: 0,
		files: 0,
		truncated: false,
		depthLimited: false,
	};
	walkTree(state, ".", 0);
	return {
		text: state.lines.join("\n"),
		entries: state.entries,
		directories: state.directories,
		files: state.files,
		truncated: state.truncated,
		depthLimited: state.depthLimited,
		focusDir: state.focusDir,
		createdDirs: state.createdDirs,
	};
}

// ------------------------------------------------------------------------------------------------
// Proposed placement state
// ------------------------------------------------------------------------------------------------

interface PlacementInput {
	file: string;
	kind: PlacementKind;
	root: string;
	targetRel: string;
	content?: string | undefined;
	exclude?: string | undefined;
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
	if (rendered.truncated || rendered.depthLimited) {
		notes.push("The project tree was cut off by its entry or depth limit; some existing paths are not shown.");
	}

	return {
		file: input.file,
		kind: input.kind,
		tree: rendered.text,
		content: limited?.text,
		note: notes.length > 0 ? notes.join(" ") : undefined,
		treeEntries: rendered.entries,
		treeTruncated: rendered.truncated,
		treeDepthLimited: rendered.depthLimited,
	};
}

/** One-line tree summary for the command output, including why it was cut off. */
function treeSummary(proposed: ProposedPlacement): string {
	const flags = [proposed.treeTruncated ? "truncated" : "", proposed.treeDepthLimited ? "depth limited" : ""].filter(
		(flag) => flag.length > 0,
	);
	return `tree: ${proposed.treeEntries} entries${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
}

// ------------------------------------------------------------------------------------------------
// What Jev is told about the state
// ------------------------------------------------------------------------------------------------
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

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------

function helpText(): string {
	return [
		"/jev-placement-guard             show status",
		"/jev-placement-guard init        write a starter .jev-placement-guard.json in the working directory",
		"/jev-placement-guard check FILE  check a path as if it were about to be created, without writing it",
		"/jev-placement-guard context [FILE]  show the merged context and the state sent to Jev",
		"/jev-placement-guard on | off    enable or disable checks for this session",
	].join("\n");
}

function showStatus(ctx: ExtensionCommandContext, state: CommandState): void {
	const config = loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), () => {});
	const settings = resolveSettings(config);
	const connection = resolveConnection(settings, uniqueDirs([ctx.cwd]));

	const lines = [
		`jev-placement-guard: ${state.isEnabled() && settings.enabled ? "on" : "off"}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
		`endpoint: ${connection.endpoint}`,
		`model: ${connection.model}`,
		`key: ${connection.credential ? `${connection.credential.name} (${connection.credential.source})` : connection.error}`,
		`minProbability: ${settings.minProbability}`,
		`onError: ${settings.onError}`,
		`timeout: ${settings.timeoutMs / 1000}s`,
		`maxFileChars: ${settings.maxFileChars}`,
		`includeFileName: ${settings.includeFileName}`,
		`fail (top-level): ${settings.fail === undefined ? "default" : `custom (${settings.fail.length} chars)`}`,
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
		ctx.ui.notify(`jev-placement-guard: ${target} already exists`, "warning");
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
		ctx.ui.notify(`jev-placement-guard: could not write ${target}: ${message(error)}`, "error");
		return;
	}
	ctx.ui.notify(
		`jev-placement-guard: wrote ${target}. Edit the rules, then run /jev-placement-guard check <file>.`,
		"info",
	);
}

async function dryRun(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const target = arg.trim();
	if (target.length === 0) {
		ctx.ui.notify("usage: /jev-placement-guard check <file>", "warning");
		return;
	}

	const absPath = path.resolve(ctx.cwd, target);
	const display = displayPath(absPath, ctx.cwd);
	if (!isInside(ctx.cwd, absPath)) {
		ctx.ui.notify(`jev-placement-guard: ${display} is outside the working directory`, "warning");
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

	const config = loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), (warning) =>
		ctx.ui.notify(`jev-placement-guard: ${warning}`, "warning"),
	);
	const settings = resolveSettings(config);
	if (isIgnored(config, absPath)) {
		ctx.ui.notify(`jev-placement-guard: ${display} is ignored by ${CONFIG_NAME}`, "info");
		return;
	}

	const matched = matchRules(config, absPath, { matchAllWhenNoFiles: true });
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) {
		ctx.ui.notify(`jev-placement-guard: no rules match ${display}`, "warning");
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
		ctx.ui.notify(`jev-placement-guard: ${connection.error ?? "no API key"}`, "error");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `jev: checking placement ${display}`);
	let outcome: JevOutcome;
	try {
		outcome = await callJev({
			endpoint: connection.endpoint,
			model: connection.model,
			apiKey: connection.credential.value,
			state: buildStateDocument(proposed, contexts, settings.includeFileName),
			describeState: describePlacementState(proposed, settings.includeFileName),
			subject: "new file",
			checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	if (!outcome.ok) {
		ctx.ui.notify(`jev-placement-guard: ${outcome.message}`, "error");
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
			`jev-placement-guard check: ${display}${content === undefined ? " (not created yet)" : ""}`,
			`endpoint: ${connection.endpoint}`,
			`model: ${connection.model}`,
			treeSummary(proposed),
			"",
			...lines,
			"",
			"state sent to Jev:",
			...displayBlock(clippedText(buildStateDocument(proposed, contexts, settings.includeFileName), CONTEXT_COMMAND)),
		].join("\n"),
		"info",
	);
}

/**
 * Shows the context and the exact state document a check would send to Jev,
 * without calling Jev. With a file it resolves the merged request; without a
 * file it shows the global context of each config.
 */
/** Config load for the context command: a target file or the working directory. */
function placementContextConfig(
	absPath: string | undefined,
	ctx: ExtensionCommandContext,
): LoadedConfig<HookConfig> | undefined {
	const warn = (warning: string) => ctx.ui.notify(`${NAME}: ${warning}`, "warning");
	if (absPath === undefined) {
		return loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), warn);
	}
	return loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
}

/** The file's whole content when readable, so the preview shows a realistic write. */
function previewContent(absPath: string): string | undefined {
	try {
		if (fs.statSync(absPath).isFile()) return fs.readFileSync(absPath, "utf8");
	} catch {
		// The file does not exist yet: show the tree and path without content.
	}
	return undefined;
}

/** The merged request preview for one file. */
function appendPlacementContext(
	lines: string[],
	absPath: string,
	display: string,
	config: LoadedConfig<HookConfig> | undefined,
	settings: ResolvedSettings,
	cwd: string,
): void {
	lines.push(
		`file line: ${settings.includeFileName ? `file: ${display} (new)` : "(disabled by includeFileName: false)"}`,
		"",
	);
	if (isIgnored(config, absPath)) {
		lines.push(`ignored by ${CONFIG_NAME}: no Jev request is sent for this file.`);
		return;
	}
	const sending = matchRules(config, absPath, { matchAllWhenNoFiles: true }).filter(
		(rule) => normalizeChecks(rule.rule, settings.minProbability).length > 0,
	);
	if (sending.length === 0) {
		lines.push("no checks apply to this file: no Jev request is sent.");
		return;
	}
	const contexts = mergedContexts(settings, sending);
	lines.push(`rules merged into one request: ${sending.length} — ${sending.map((rule) => ruleLabel(rule)).join(", ")}`);
	if (contexts.length === 0) {
		lines.push("merged context: (none)");
	} else {
		lines.push(`merged context (${contexts.length} part(s)):`, ...displayBlock(contexts.join("\n\n")));
	}
	const targetRel = toPosix(path.relative(cwd, absPath));
	const proposed = buildPlacementState({
		file: display,
		kind: "new file",
		root: cwd,
		targetRel,
		content: previewContent(absPath),
		exclude: targetRel,
		settings,
	});
	lines.push(
		treeSummary(proposed),
		"",
		"state sent to Jev (as a new file):",
		...displayBlock(buildStateDocument(proposed, contexts, settings.includeFileName)),
	);
}

function normalizeRel(value: string): string {
	const posix = toPosix(value).replace(/\/+$/, "").replace(/^\.\//, "");
	return posix.length === 0 ? "." : posix;
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
		ctx.ui.notify(`jev-placement-guard: ${displayPath(absPath, ctx.cwd)} is outside the working directory`, "warning");
		return;
	}

	const display = absPath === undefined ? undefined : displayPath(absPath, ctx.cwd);
	const config = placementContextConfig(absPath, ctx);
	const settings = resolveSettings(config);
	const lines: string[] = [
		display === undefined ? "jev-placement-guard context" : `jev-placement-guard context: ${display}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
		`enabled: ${settings.enabled}   onlyNewFiles: ${settings.onlyNewFiles}   includeFileName: ${settings.includeFileName}`,
		"",
		...contextLines(config),
	];

	if (display === undefined || absPath === undefined) {
		lines.push("", `Rules need a target file: run ${CONTEXT_COMMAND} <file> to see the merged request state.`);
	} else {
		appendPlacementContext(lines, absPath, display, config, settings, ctx.cwd);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}
