/**
 * jev-tree-guard — semantic placement checks for newly created files, backed by TypeSafe Jev (System One).
 *
 * Hooks the `write` tool. When the target path does not exist yet, the extension
 * renders the existing project tree (bounded and ignore-aware), attaches the
 * proposed file content, and asks Jev whether the new file belongs where it is
 * being added. A failed check blocks the write and returns the rule's `fail`
 * text to the model.
 *
 * The nearest `.jev-tree-guard.json` on the way up to the filesystem root is
 * used, and only inside the trusted working directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
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
import type {
	BaseConfig,
	BaseSettings,
	CommandState,
	GuardFlavor,
	JevOutcome,
	LoadedConfig,
} from "@pi-jev/core";

// Re-exported for the tests that exercise the shared helpers.
export { globToRegExp, parseDotEnv, renderTemplate } from "@pi-jev/core";

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------

const NAME = "jev-tree-guard";
const CONFIG_NAME = ".jev-tree-guard.json";
const STATUS_KEY = "jev-tree-guard";
const CONTEXT_COMMAND = "/jev-tree-guard context";

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
	content?: string;
	note?: string;
	/** Local-only diagnostics; not part of the state sent to Jev. */
	treeEntries: number;
	treeTruncated: boolean;
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
		if (!sessionEnabled || disabledByEnv("JEV_TREE_GUARD_DISABLE")) return undefined;
		if (event.toolName !== "write") return undefined;

		const input = event.input as Record<string, unknown>;
		const rawPath = input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
		if (typeof input.content !== "string") return undefined;

		const absPath = path.resolve(ctx.cwd, rawPath);
		const display = displayPath(absPath, ctx.cwd);
		const warn = (message: string) => warnings.warn(ctx, message);

		if (!isInside(ctx.cwd, absPath)) {
			warn(`skipping ${display}: the file is outside the working directory, so no project tree is available`);
			return undefined;
		}

		const isNew = !fs.existsSync(absPath);

		const config = loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
		if (!config) return undefined;

		const settings = resolveSettings(config);
		if (!settings.enabled) return undefined;
		if (!isNew && settings.onlyNewFiles) return undefined;
		if (isIgnored(config, absPath)) return undefined;

		const matched = matchRules(config, absPath, { matchAllWhenNoFiles: true });
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
			return handleCheckError(settings, ctx, FLAVOR, connection.error ?? "No Jev API key found.", display, warn);
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
			return handleCheckError(settings, ctx, FLAVOR, outcome.message, display, warn);
		}

		const failures = checks.filter(
			(check) =>
				satisfiedProbability(check, outcome.probabilities.get(check.name) ?? 0) < check.minProbability,
		);
		if (failures.length === 0) return undefined;

		ctx.ui.notify(`${NAME}: blocked ${display} (${failures.length} check(s) failed)`, "warning");
		return {
			block: true,
			reason: buildFailureReason(failures, outcome.probabilities, settings, display, (file, details) =>
				`Jev placement check failed for ${file}:\n${details}\nChoose a directory or file name that fits the existing tree, then retry the write.`,
			),
		};
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
		"/jev-tree-guard             show status",
		"/jev-tree-guard init        write a starter .jev-tree-guard.json in the working directory",
		"/jev-tree-guard check FILE  check a path as if it were about to be created, without writing it",
		"/jev-tree-guard context [FILE]  show the merged context and the state sent to Jev",
		"/jev-tree-guard on | off    enable or disable checks for this session",
	].join("\n");
}

function showStatus(ctx: ExtensionCommandContext, state: CommandState): void {
	const config = loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), () => {});
	const settings = resolveSettings(config);
	const connection = resolveConnection(settings, uniqueDirs([ctx.cwd]));

	const lines = [
		`jev-tree-guard: ${state.isEnabled() && settings.enabled ? "on" : "off"}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
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

	const config = loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), (warning) =>
		ctx.ui.notify(`jev-tree-guard: ${warning}`, "warning"),
	);
	const settings = resolveSettings(config);
	if (isIgnored(config, absPath)) {
		ctx.ui.notify(`jev-tree-guard: ${display} is ignored by ${CONFIG_NAME}`, "info");
		return;
	}

	const matched = matchRules(config, absPath, { matchAllWhenNoFiles: true });
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
function showContext(arg: string, ctx: ExtensionCommandContext): void {
	const target = arg.trim();
	const absPath = target.length > 0 ? path.resolve(ctx.cwd, target) : undefined;
	if (absPath !== undefined && !isInside(ctx.cwd, absPath)) {
		ctx.ui.notify(`jev-tree-guard: ${displayPath(absPath, ctx.cwd)} is outside the working directory`, "warning");
		return;
	}

	const display = absPath === undefined ? undefined : displayPath(absPath, ctx.cwd);
	const warn = (warning: string) => ctx.ui.notify(`jev-tree-guard: ${warning}`, "warning");
	const config =
		absPath === undefined
			? loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), warn)
			: loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
	const settings = resolveSettings(config);

	const lines: string[] = [
		display === undefined ? "jev-tree-guard context" : `jev-tree-guard context: ${display}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
		`enabled: ${settings.enabled}   onlyNewFiles: ${settings.onlyNewFiles}   includeFileName: ${settings.includeFileName}`,
		"",
		...contextLines(config),
	];

	if (display === undefined || absPath === undefined) {
		lines.push("", `Rules need a target file: run ${CONTEXT_COMMAND} <file> to see the merged request state.`);
	} else {
		lines.push(
			`file line: ${settings.includeFileName ? `file: ${display} (new)` : "(disabled by includeFileName: false)"}`,
			"",
		);
		if (isIgnored(config, absPath)) {
			lines.push(`ignored by ${CONFIG_NAME}: no Jev request is sent for this file.`);
		} else {
			const sending = matchRules(config, absPath, { matchAllWhenNoFiles: true }).filter(
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

function normalizeRel(value: string): string {
	const posix = toPosix(value).replace(/\/+$/, "").replace(/^\.\//, "");
	return posix.length === 0 ? "." : posix;
}

