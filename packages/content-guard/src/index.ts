/**
 * jev-content-guard — semantic file-edit checks backed by TypeSafe Jev (System One).
 *
 * Hooks the `edit` and `write` tool calls. For each target file it finds the
 * nearest `.jev-content-guard.json` on the way up to the filesystem root (AGENTS.md-style
 * discovery), matches the file against the configured rules, and asks Jev
 * whether the proposed content satisfies each check.
 *
 * A check that is not satisfied blocks the tool call: the rule's `fail` string
 * (or a generated one) is returned to the model as the tool error.
 *
 * Configs apply only inside the trusted working directory.
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
	MatchedRule,
	PendingCheck,
} from "@pi-jev/core";
import {
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
	OPENROUTER_ENDPOINT,
	OPENROUTER_MODEL,
	percent,
	resolveBaseSettings,
	resolveConnection,
	ruleLabel,
	runCommand,
	satisfiedProbability,
	stringSetting,
	uniqueDirs,
} from "@pi-jev/core";

// Re-exported for the tests that exercise the shared helpers.
export { globToRegExp, parseDotEnv, renderTemplate } from "@pi-jev/core";

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------

const NAME = "jev-content-guard";
const CONFIG_NAME = ".jev-content-guard.json";
const STATUS_KEY = "jev-content-guard";
const CONTEXT_COMMAND = "/jev-content-guard context";

/** Messages core renders on this guard's behalf. */
const FLAVOR: GuardFlavor = {
	name: NAME,
	configName: CONFIG_NAME,
	checkLabel: "Jev check",
	action: "edit",
};

type Scope = "file" | "change" | "both";

interface HookConfig extends BaseConfig {
	scope?: Scope;
}

interface ResolvedSettings extends BaseSettings {
	scope?: Scope | undefined;
}

interface ProposedContent {
	file: string;
	scope: Scope;
	content?: string | undefined;
	change?: string | undefined;
	note?: string | undefined;
}

/** The resolved target for a checked call, or undefined when the call is out of scope. */
function checkedTarget(
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
): { toolName: "edit" | "write"; absPath: string; display: string; input: Record<string, unknown> } | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	const input = event.input as Record<string, unknown>;
	const rawPath = input["path"];
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	const absPath = path.resolve(ctx.cwd, rawPath);
	return { toolName: event.toolName, absPath, display: displayPath(absPath, ctx.cwd), input };
}

/** The config, checks, and proposed content for one in-scope tool call. */
interface PreparedCheck {
	settings: ResolvedSettings;
	matched: MatchedRule<HookConfig>[];
	checks: PendingCheck<HookConfig>[];
	proposed: ProposedContent;
}

/** Load and match the config for the call; undefined when nothing should run. */
function prepareCheck(
	toolName: "edit" | "write",
	absPath: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
	warn: (message: string) => void,
): PreparedCheck | undefined {
	const config = loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
	if (!config) return undefined;
	const settings = resolveSettings(config);
	if (!settings.enabled) return undefined;
	const matched = matchRules(config, absPath);
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) return undefined;
	const scope = settings.scope ?? (toolName === "write" ? "file" : "change");
	const proposed = buildProposedContent(toolName, absPath, input, ctx.cwd, scope, settings.maxFileChars);
	if (!proposed) return undefined;
	return { settings, matched, checks, proposed };
}

/** The checks whose probability is below their threshold. */
function failedChecks(
	checks: PendingCheck<HookConfig>[],
	probabilities: Map<string, number>,
): PendingCheck<HookConfig>[] {
	return checks.filter(
		(check) => satisfiedProbability(check, probabilities.get(check.name) ?? 0) < check.minProbability,
	);
}

/** Run the Jev request with the status line bracketed around it. */
async function requestJev(
	settings: ResolvedSettings,
	target: { endpoint: string; model: string; apiKey: string },
	prepared: { proposed: ProposedContent; contexts: string[]; checks: PendingCheck<HookConfig>[] },
	ctx: ExtensionContext,
	display: string,
): Promise<JevOutcome> {
	ctx.ui.setStatus(STATUS_KEY, `jev: checking ${display}`);
	try {
		return await callJev({
			endpoint: target.endpoint,
			model: target.model,
			apiKey: target.apiKey,
			state: buildStateDocument(prepared.proposed, prepared.contexts, settings.includeFileName),
			describeState: describeState(prepared.proposed, settings.includeFileName),
			subject: "new content",
			checks: prepared.checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

/** The blocked result with the failure text for the model. */
function blockedResult(
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
				`Jev check failed for ${file}:\n${details}\nFix the content so every check passes, then retry the edit.`,
		),
	};
}

/** Resolve the connection, call Jev, and turn the verdict into a tool result. */
async function runCheck(
	prepared: PreparedCheck,
	absPath: string,
	display: string,
	ctx: ExtensionContext,
	warn: (message: string) => void,
): Promise<ToolCallEventResult | undefined> {
	const { settings, matched, checks, proposed } = prepared;
	const contexts = mergedContexts(settings, matched);
	const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
	const credential = connection.credential;
	if (!credential) {
		return handleCheckError(settings, ctx, FLAVOR, connection.error ?? "No Jev API key found.", display, warn);
	}
	const outcome = await requestJev(
		settings,
		{ endpoint: connection.endpoint, model: connection.model, apiKey: credential.value },
		{ proposed, contexts, checks },
		ctx,
		display,
	);
	if (!outcome.ok) return handleCheckError(settings, ctx, FLAVOR, outcome.message, display, warn);
	const failures = failedChecks(checks, outcome.probabilities);
	if (failures.length === 0) return undefined;
	return blockedResult(failures, outcome.probabilities, settings, display, ctx);
}

// ------------------------------------------------------------------------------------------------
// Extension entry point
// ------------------------------------------------------------------------------------------------

export default function jevHooks(pi: ExtensionAPI): void {
	let sessionEnabled = true;

	pi.on("session_start", () => {
		sessionEnabled = true;
		warnings.reset();
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!sessionEnabled || disabledByEnv("JEV_CONTENT_GUARD_DISABLE")) return undefined;
		const target = checkedTarget(event, ctx);
		if (!target) return undefined;
		const warn = (message: string) => warnings.warn(ctx, message);
		const prepared = prepareCheck(target.toolName, target.absPath, target.input, ctx, warn);
		if (!prepared) return undefined;
		return await runCheck(prepared, target.absPath, target.display, ctx, warn);
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
				switchLabel: "checks",
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

	pi.registerCommand("jev-content-guard", {
		description: "Show, initialize, or dry-run .jev-content-guard.json semantic checks",
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
	const scope = stringSetting(config, "scope");
	return {
		...resolveBaseSettings(config),
		scope: scope === "file" || scope === "change" || scope === "both" ? scope : undefined,
	};
}

/**
 * Formats the Jev state as one document: the merged context, the
 * project-relative path, the proposed content, and the diff.
 */
function buildStateDocument(proposed: ProposedContent, contexts: string[], includeFileName: boolean): string {
	const sections: string[] = [];
	if (contexts.length > 0) sections.push(contexts.join("\n\n"));
	const fileLine = includeFileName ? `file: ${proposed.file}` : undefined;
	if (fileLine !== undefined && proposed.content !== undefined) {
		sections.push(`${fileLine}\n${fenced(proposed.content)}`);
	} else {
		if (fileLine !== undefined) sections.push(fileLine);
		if (proposed.content !== undefined) sections.push(fenced(proposed.content));
	}
	if (proposed.change !== undefined) sections.push(`file edit\n${fenced(proposed.change, "diff")}`);
	if (proposed.note) sections.push(`note: ${proposed.note}`);
	return sections.join("\n\n");
}

// ------------------------------------------------------------------------------------------------
// Proposed content
// ------------------------------------------------------------------------------------------------

/** The write branch: the whole file content, bounded. */
function proposedFromWrite(
	input: Record<string, unknown>,
	file: string,
	maxFileChars: number,
): ProposedContent | undefined {
	if (typeof input["content"] !== "string") return undefined;
	const limited = limitText(input["content"], maxFileChars);
	return { file, scope: "file", content: limited.text, note: limited.note };
}

/** The branch taken when the resulting file could be predicted. */
function proposedFromPredicted(
	predicted: string,
	change: string | undefined,
	file: string,
	scope: Scope,
	maxFileChars: number,
): ProposedContent {
	const limited = limitText(predicted, maxFileChars);
	if (scope === "both" && change) {
		return { file, scope: "both", content: limited.text, change, note: limited.note };
	}
	if (scope === "file" && predicted.length > maxFileChars && change) {
		return {
			file,
			scope: "change",
			change,
			note: "The full file is larger than maxFileChars; only the edited blocks are shown.",
		};
	}
	return { file, scope: "file", content: limited.text, note: limited.note };
}

function buildProposedContent(
	toolName: "edit" | "write",
	absPath: string,
	input: Record<string, unknown>,
	cwd: string,
	scope: Scope,
	maxFileChars: number,
): ProposedContent | undefined {
	const file = displayPath(absPath, cwd);
	if (toolName === "write") return proposedFromWrite(input, file, maxFileChars);

	const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
	const change = renderChange(edits);
	const predicted = predictContent(absPath, edits);
	if (predicted !== undefined && scope !== "change") {
		return proposedFromPredicted(predicted, change, file, scope, maxFileChars);
	}
	if (!change) return undefined;
	return {
		file,
		scope: "change",
		change,
		note:
			scope === "change"
				? undefined
				: "The full resulting file could not be computed; only the edited blocks are shown.",
	};
}

interface EditSpec {
	oldText: string;
	newText: string;
}

function readEdits(edits: unknown[]): EditSpec[] | undefined {
	const out: EditSpec[] = [];
	for (const raw of edits) {
		if (!raw || typeof raw !== "object") return undefined;
		const edit = raw as { oldText?: unknown; newText?: unknown };
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") return undefined;
		out.push({ oldText: edit.oldText, newText: edit.newText });
	}
	return out;
}

/** Match every edit once and reject overlaps; undefined when the prediction cannot be trusted. */
function matchedSpans(
	original: string,
	edits: EditSpec[],
): Array<{ start: number; end: number; text: string }> | undefined {
	const spans: Array<{ start: number; end: number; text: string }> = [];
	for (const edit of edits) {
		if (edit.oldText.length === 0) return undefined;
		const first = original.indexOf(edit.oldText);
		if (first < 0) return undefined;
		if (original.indexOf(edit.oldText, first + edit.oldText.length) >= 0) return undefined;
		spans.push({ start: first, end: first + edit.oldText.length, text: edit.newText });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const current = spans[i];
		const previous = spans[i - 1];
		if (current && previous && current.start < previous.end) return undefined;
	}
	return spans;
}

function applySpans(original: string, spans: Array<{ start: number; end: number; text: string }>): string {
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += original.slice(cursor, span.start) + span.text;
		cursor = span.end;
	}
	return out + original.slice(cursor);
}

/**
 * Applies edits the way the edit tool does for the common exact-match case.
 * Returns undefined when the file is unreadable, a match is missing or not
 * unique, or edits overlap; the caller then falls back to the edited blocks.
 */
export function predictContent(absPath: string, rawEdits: unknown[]): string | undefined {
	const edits = readEdits(rawEdits);
	if (!edits || edits.length === 0) return undefined;

	let original: string;
	try {
		original = fs.readFileSync(absPath, "utf8");
	} catch {
		return undefined;
	}

	const spans = matchedSpans(original, edits);
	if (!spans) return undefined;
	return applySpans(original, spans);
}

function renderChange(rawEdits: unknown[]): string | undefined {
	const blocks: string[] = [];
	rawEdits.forEach((raw, index) => {
		if (!raw || typeof raw !== "object") return;
		const edit = raw as { oldText?: unknown; newText?: unknown };
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") return;
		blocks.push(`### Edit ${index + 1}\n--- before\n${edit.oldText}\n+++ after\n${edit.newText}`);
	});
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

// ------------------------------------------------------------------------------------------------
// What Jev is told about the state
// ------------------------------------------------------------------------------------------------
function describeState(state: ProposedContent, includeFileName: boolean): string {
	const parts: string[] = [];
	if (includeFileName) parts.push("the target file path");
	if (state.content !== undefined) parts.push("the file's complete proposed content");
	if (state.change !== undefined) parts.push("the diff of the edited blocks");
	return parts.length > 0 ? parts.join(", ") : "the proposed content";
}

// ------------------------------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------------------------------

function helpText(): string {
	return [
		"/jev-content-guard             show status",
		"/jev-content-guard init        write a starter .jev-content-guard.json in the working directory",
		"/jev-content-guard check FILE  run the matching checks against FILE without editing it",
		"/jev-content-guard context [FILE]  show the merged context and the state sent to Jev",
		"/jev-content-guard on | off    enable or disable checks for this session",
	].join("\n");
}

function showStatus(ctx: ExtensionCommandContext, state: CommandState): void {
	const config = loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), () => {});
	const settings = resolveSettings(config);
	const connection = resolveConnection(settings, uniqueDirs([ctx.cwd]));

	const lines = [
		`jev-content-guard: ${state.isEnabled() && settings.enabled ? "on" : "off"}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
		`endpoint: ${connection.endpoint}`,
		`model: ${connection.model}`,
		`key: ${connection.credential ? `${connection.credential.name} (${connection.credential.source})` : connection.error}`,
		"",
		helpText(),
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

function initConfig(ctx: ExtensionCommandContext): void {
	const target = path.join(ctx.cwd, CONFIG_NAME);
	if (fs.existsSync(target)) {
		ctx.ui.notify(`jev-content-guard: ${target} already exists`, "warning");
		return;
	}

	const keys = collectKeys(uniqueDirs([ctx.cwd]));
	const starter: HookConfig = {
		enabled: true,
		minProbability: DEFAULT_MIN_PROBABILITY,
		onError: "allow",
		context: "Project conventions every check should consider. This text is sent to Jev with each check.",
		rules: [
			{
				name: "TypeScript",
				files: ["**/*.ts", "**/*.tsx"],
				checks: ["No `any` type is used", "No console.log statements are added"],
				fail: "Jev check failed for {file}:\n{checks}\nFix the content so every check passes, then retry the edit.",
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
		ctx.ui.notify(`jev-content-guard: could not write ${target}: ${message(error)}`, "error");
		return;
	}
	ctx.ui.notify(
		`jev-content-guard: wrote ${target}. Edit the rules, then run /jev-content-guard check <file>.`,
		"info",
	);
}

async function dryRun(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const target = arg.trim();
	if (target.length === 0) {
		ctx.ui.notify("usage: /jev-content-guard check <file>", "warning");
		return;
	}

	const absPath = path.resolve(ctx.cwd, target);
	const display = displayPath(absPath, ctx.cwd);
	let content: string;
	try {
		if (!fs.statSync(absPath).isFile()) throw new Error("not a file");
		content = fs.readFileSync(absPath, "utf8");
	} catch (error) {
		ctx.ui.notify(`jev-content-guard: cannot read ${absPath}: ${message(error)}`, "error");
		return;
	}

	const config = loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), (warning) =>
		ctx.ui.notify(`jev-content-guard: ${warning}`, "warning"),
	);
	const settings = resolveSettings(config);
	if (isIgnored(config, absPath)) {
		ctx.ui.notify(`jev-content-guard: ${display} is ignored by ${CONFIG_NAME}`, "info");
		return;
	}

	const matched = matchRules(config, absPath);
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) {
		ctx.ui.notify(`jev-content-guard: no rules match ${display}`, "warning");
		return;
	}

	const limited = limitText(content, settings.maxFileChars);
	const proposed: ProposedContent = { file: display, scope: "file", content: limited.text, note: limited.note };
	const contexts = mergedContexts(settings, matched);
	const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
	if (!connection.credential) {
		ctx.ui.notify(`jev-content-guard: ${connection.error ?? "no API key"}`, "error");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `jev: checking ${display}`);
	let outcome: JevOutcome;
	try {
		outcome = await callJev({
			endpoint: connection.endpoint,
			model: connection.model,
			apiKey: connection.credential.value,
			state: buildStateDocument(proposed, contexts, settings.includeFileName),
			describeState: describeState(proposed, settings.includeFileName),
			subject: "new content",
			checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	if (!outcome.ok) {
		ctx.ui.notify(`jev-content-guard: ${outcome.message}`, "error");
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
			`jev-content-guard check: ${display}`,
			`endpoint: ${connection.endpoint}`,
			`model: ${connection.model}`,
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
function contextConfig(
	absPath: string | undefined,
	ctx: ExtensionCommandContext,
): LoadedConfig<HookConfig> | undefined {
	const warn = (warning: string) => ctx.ui.notify(`${NAME}: ${warning}`, "warning");
	if (absPath === undefined) {
		return loadConfigFromDir<HookConfig>(CONFIG_NAME, ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), warn);
	}
	return loadConfig<HookConfig>(CONFIG_NAME, absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
}

/** The file's whole content when readable, so the preview shows a realistic request. */
function previewProposed(absPath: string, display: string, settings: ResolvedSettings): ProposedContent {
	try {
		if (fs.statSync(absPath).isFile()) {
			const limited = limitText(fs.readFileSync(absPath, "utf8"), settings.maxFileChars);
			return { file: display, scope: "file", content: limited.text, note: limited.note };
		}
	} catch {
		// The file does not exist yet: show the request without content.
	}
	return { file: display, scope: "file" };
}

/** The merged request preview for one file. */
function appendFileContext(
	lines: string[],
	absPath: string,
	display: string,
	config: LoadedConfig<HookConfig> | undefined,
	settings: ResolvedSettings,
): void {
	lines.push(
		`file line: ${settings.includeFileName ? `file: ${display}` : "(disabled by includeFileName: false)"}`,
		"",
	);
	if (isIgnored(config, absPath)) {
		lines.push(`ignored by ${CONFIG_NAME}: no Jev request is sent for this file.`);
		return;
	}
	const sending = matchRules(config, absPath).filter(
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
	lines.push(
		"",
		"state sent to Jev (whole file; an edit request follows `scope`):",
		...displayBlock(
			buildStateDocument(previewProposed(absPath, display, settings), contexts, settings.includeFileName),
		),
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
		ctx.ui.notify(`${NAME}: ${displayPath(absPath, ctx.cwd)} is outside the working directory`, "warning");
		return;
	}

	const display = absPath === undefined ? undefined : displayPath(absPath, ctx.cwd);
	const config = contextConfig(absPath, ctx);
	const settings = resolveSettings(config);
	const lines: string[] = [
		display === undefined ? "jev-content-guard context" : `jev-content-guard context: ${display}`,
		config ? `config: ${config.file} — ${ruleCount(config)} rule(s)` : "config: none",
		`enabled: ${settings.enabled}   includeFileName: ${settings.includeFileName}`,
		"",
		...contextLines(config),
	];

	if (display === undefined || absPath === undefined) {
		lines.push("", `Rules need a target file: run ${CONTEXT_COMMAND} <file> to see the merged request state.`);
	} else {
		appendFileContext(lines, absPath, display, config, settings);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}
