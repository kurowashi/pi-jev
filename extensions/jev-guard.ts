/**
 * jev-guard — semantic file-edit checks backed by TypeSafe Jev (System One).
 *
 * Hooks the `edit` and `write` tool calls. For each target file it finds
 * `.jev-guard.json` configs from the file's directory up to the filesystem
 * root (AGENTS.md-style discovery), matches the file against the configured
 * rules, and asks Jev whether the proposed content satisfies each check.
 *
 * A check that is not satisfied blocks the tool call: the rule's `fail` string
 * (or a generated one) is returned to the model as the tool error.
 *
 * Project configs apply only inside the trusted working directory. The user
 * config at `~/.pi/agent/jev-guard.json` always applies.
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

const CONFIG_NAME = ".jev-guard.json";
const AGENT_DIR = nonEmpty(process.env.PI_CODING_AGENT_DIR) ?? path.join(os.homedir(), ".pi", "agent");
const GLOBAL_CONFIG_PATH = path.join(AGENT_DIR, CONFIG_NAME);
const STATUS_KEY = "jev-guard";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_MODEL = "typesafe/jev-1.13";

const DEFAULT_MIN_PROBABILITY = 0.5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_FILE_CHARS = 40_000;

const KEY_NAMES = [
	"SYSTEMONE_API_KEY",
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
	"OPENCODE_API_KEY",
	"OPENCODE_ZEN_API_KEY",
	"COMMANDCODE_API_KEY",
];

type Scope = "file" | "change" | "both";
type OnError = "allow" | "block";

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
	 * Jev answers the statement as written and the probability is inverted, so
	 * "dirty code" can be used instead of "No dirty code".
	 */
	negate?: boolean;
}

interface RuleConfig {
	/** Label used in `{rule}` and failure output. */
	name?: string;
	/** Set to false to disable a rule without deleting it. */
	enabled?: boolean;
	/** Glob(s) relative to the config file's directory. No slash matches the basename. Prefix with `!` to exclude. */
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
	scope?: Scope;
	/** Include the target file's name in the context sent to Jev (default true). */
	includeFileName?: boolean;
	maxFileChars?: number;
	timeoutMs?: number;
	fail?: string;
	/** Extra context sent to Jev with every request (all rules). */
	context?: string;
	/** Glob(s) relative to the config file's directory; matching files are never checked. */
	ignore?: string | string[];
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
	scope?: Scope;
	includeFileName: boolean;
	maxFileChars: number;
	timeoutMs: number;
	fail?: string;
	context?: string;
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

type ProposedContent = {
	file: string;
	scope: Scope;
	content?: string;
	change?: string;
	note?: string;
	context?: string;
};

type JevOutcome =
	| { ok: true; probabilities: Map<string, number> }
	| { ok: false; message: string };

// ------------------------------------------------------------------------------------------------
// Extension entry point
// ------------------------------------------------------------------------------------------------

export default function jevHooks(pi: ExtensionAPI): void {
	let sessionEnabled = true;

	pi.on("session_start", () => {
		sessionEnabled = true;
		warned.clear();
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!sessionEnabled || disabledByEnv()) return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

		const input = event.input as Record<string, unknown>;
		const rawPath = input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

		const absPath = path.resolve(ctx.cwd, rawPath);
		const display = displayPath(absPath, ctx.cwd);
		const warn = (message: string) => warnOnce(ctx, message);

		const chain = loadConfigChain(absPath, ctx.cwd, ctx.isProjectTrusted(), warn);
		if (chain.length === 0) return undefined;

		const settings = resolveSettings(chain);
		if (!settings.enabled) return undefined;

		const matched = matchRules(chain, absPath);
		const checks = collectChecks(matched, settings.minProbability);
		if (checks.length === 0) return undefined;

		const scope = settings.scope ?? (event.toolName === "write" ? "file" : "change");
		const proposed = buildProposedContent(
			event.toolName,
			absPath,
			input,
			ctx.cwd,
			scope,
			settings.maxFileChars,
			withFileName(display, settings.context, settings.includeFileName),
		);
		if (!proposed) return undefined;

		const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
		if (!connection.credential) {
			return handleCheckError(settings, ctx, connection.error ?? "No Jev API key found.", display);
		}

		ctx.ui.setStatus(STATUS_KEY, `jev: checking ${display}`);
		let outcome: JevOutcome;
		try {
			outcome = await callJev({
				endpoint: connection.endpoint,
				model: connection.model,
				apiKey: connection.credential.value,
				state: proposed,
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

		ctx.ui.notify(`jev-guard: blocked ${display} (${failures.length} check(s) failed)`, "warning");
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

	pi.registerCommand("jev-guard", {
		description: "Show, initialize, or dry-run .jev-guard.json semantic checks",
		handler: commandHandler,
	});
	pi.registerCommand("jev", {
		description: "Alias of /jev-guard",
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
	ctx.ui.notify(`jev-guard: ${message}`, "warning");
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
	const scope = firstSetting(chain, "scope");
	return {
		enabled: firstSetting(chain, "enabled") !== false,
		endpoint: stringSetting(chain, "endpoint"),
		model: stringSetting(chain, "model"),
		apiKeyEnv: stringSetting(chain, "apiKeyEnv"),
		minProbability: numberSetting(chain, "minProbability") ?? DEFAULT_MIN_PROBABILITY,
		onError: onError === "block" ? "block" : "allow",
		scope: scope === "file" || scope === "change" || scope === "both" ? scope : undefined,
		includeFileName: firstSetting(chain, "includeFileName") !== false,
		maxFileChars: numberSetting(chain, "maxFileChars") ?? DEFAULT_MAX_FILE_CHARS,
		timeoutMs: numberSetting(chain, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
		fail: stringSetting(chain, "fail"),
		context: stringSetting(chain, "context"),
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

// ------------------------------------------------------------------------------------------------
// Rule matching
// ------------------------------------------------------------------------------------------------

/** True when any config in the chain ignores the file, so no rule applies. */
function isIgnored(chain: LoadedConfig[], filePath: string): boolean {
	return chain.some((config) => matchesFilePatterns(config.config.ignore, config.baseDir, filePath));
}

function matchRules(chain: LoadedConfig[], filePath: string): MatchedRule[] {
	if (isIgnored(chain, filePath)) return [];

	const matched: MatchedRule[] = [];
	for (const config of chain) {
		const rules = config.config.rules;
		if (!Array.isArray(rules)) continue;
		for (const rule of rules) {
			if (!rule || typeof rule !== "object" || rule.enabled === false) continue;
			if (matchesFilePatterns(rule.files, config.baseDir, filePath)) matched.push({ rule, config });
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

/** Prefixes the context with the target file name so Jev can take the path into account. */
function withFileName(file: string, context: string | undefined, include: boolean): string | undefined {
	if (!include) return context;
	const line = `Target file: ${file}`;
	return context ? `${line}\n\n${context}` : line;
}

/** Global context plus the rule's own context; one blob is one rule. */
function blobContext(base: string | undefined, rule: MatchedRule): string | undefined {
	const parts: string[] = [];
	if (base) parts.push(base);
	if (typeof rule.rule.context === "string" && rule.rule.context.trim().length > 0) {
		parts.push(rule.rule.context.trim());
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ------------------------------------------------------------------------------------------------
// Proposed content
// ------------------------------------------------------------------------------------------------

function buildProposedContent(
	toolName: "edit" | "write",
	absPath: string,
	input: Record<string, unknown>,
	cwd: string,
	scope: Scope,
	maxFileChars: number,
	context: string | undefined,
): ProposedContent | undefined {
	const file = displayPath(absPath, cwd);

	if (toolName === "write") {
		if (typeof input.content !== "string") return undefined;
		const limited = limitText(input.content, maxFileChars);
		return { file, scope: "file", content: limited.text, note: limited.note, context };
	}

	const edits = Array.isArray(input.edits) ? input.edits : [];
	const change = renderChange(edits);
	const predicted = predictContent(absPath, edits);

	if (predicted !== undefined && scope !== "change") {
		const limited = limitText(predicted, maxFileChars);
		if (scope === "both" && change) {
			return { file, scope: "both", content: limited.text, change, note: limited.note, context };
		}
		if (scope === "file" && predicted.length > maxFileChars && change) {
			return {
				file,
				scope: "change",
				change,
				context,
				note: "The full file is larger than maxFileChars; only the edited blocks are shown.",
			};
		}
		return { file, scope: "file", content: limited.text, note: limited.note, context };
	}

	if (!change) return undefined;
	return {
		file,
		scope: "change",
		change,
		context,
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
		if (spans[i]!.start < spans[i - 1]!.end) return undefined;
	}

	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += original.slice(cursor, span.start) + span.text;
		cursor = span.end;
	}
	return out + original.slice(cursor);
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
	state: ProposedContent;
	checks: PendingCheck[];
	timeoutMs: number;
}

/** One Jev request per matched rule: each rule is a blob with its own context. */
async function callJev(request: JevRequest): Promise<JevOutcome> {
	const groups = new Map<MatchedRule, PendingCheck[]>();
	for (const check of request.checks) {
		const list = groups.get(check.rule);
		if (list) list.push(check);
		else groups.set(check.rule, [check]);
	}

	const outcomes = await Promise.all(
		[...groups].map(([rule, checks]) =>
			callJevBlob({
				...request,
				checks,
				state: { ...request.state, context: blobContext(request.state.context, rule) },
			}),
		),
	);

	const probabilities = new Map<string, number>();
	for (const outcome of outcomes) {
		if (!outcome.ok) return outcome;
		for (const [name, value] of outcome.probabilities) probabilities.set(name, value);
	}
	return { ok: true, probabilities };
}

async function callJevBlob(request: JevRequest): Promise<JevOutcome> {
	const questions: Record<string, unknown> = {};
	for (const check of request.checks) {
		const ask = check.negate
			? `Answer yes if the following statement describes the new content: ${check.text}`
			: `Answer yes if the new content satisfies this requirement: ${check.text}`;
		questions[check.name] = {
			type: "noul",
			instructions: `The state contains ${describeState(request.state)}. ${ask}`,
			criteria: check.negate
				? { true: "The statement describes the new content.", false: "The statement does not describe the new content." }
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
			body: JSON.stringify({ model: request.model, state: request.state, questions }),
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

function describeState(state: unknown): string {
	const scope = state && typeof state === "object" ? (state as { scope?: unknown }).scope : undefined;
	if (scope === "change") return "a proposed change to a file";
	if (scope === "both") return "a file's complete proposed content and the edited blocks it changes";
	return "a file's complete proposed content";
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
		ctx.ui.notify(`jev-guard: ${message}`, "error");
		return {
			block: true,
			reason: `Jev check could not run for ${display}: ${message}.\nSet "onError": "allow" in ${CONFIG_NAME} to let edits through when Jev is unavailable.`,
		};
	}
	warnOnce(ctx, `${message} (edit allowed)`);
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
					rule: rule.rule.name ?? path.basename(rule.config.file),
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
				`Jev check failed for ${file}:\n${details}\nFix the content so every check passes, then retry the edit.`,
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
		case "on":
			state.setEnabled(true);
			ctx.ui.notify("jev-guard: checks enabled", "info");
			return;
		case "off":
			state.setEnabled(false);
			ctx.ui.notify("jev-guard: checks disabled for this session", "info");
			return;
		default:
			ctx.ui.notify(helpText(), "info");
	}
}

function helpText(): string {
	return [
		"/jev-guard             show status",
		"/jev-guard init        write a starter .jev-guard.json in the working directory",
		"/jev-guard check FILE  run the matching checks against FILE without editing it",
		"/jev-guard on | off    enable or disable checks for this session",
	].join("\n");
}

function showStatus(ctx: ExtensionCommandContext, state: CommandState): void {
	const chain = loadConfigChainFromDir(ctx.cwd, ctx.cwd, ctx.isProjectTrusted(), () => {});
	const settings = resolveSettings(chain);
	const connection = resolveConnection(settings, uniqueDirs([ctx.cwd]));
	const ruleCount = (entry: LoadedConfig) => (Array.isArray(entry.config.rules) ? entry.config.rules.length : 0);

	const lines = [
		`jev-guard: ${state.isEnabled() && settings.enabled ? "on" : "off"}`,
		`configs: ${chain.length === 0 ? "none" : ""}`.trimEnd(),
		...chain.map((entry) => `  ${entry.file} — ${ruleCount(entry)} rule(s)`),
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
		ctx.ui.notify(`jev-guard: ${target} already exists`, "warning");
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
		ctx.ui.notify(`jev-guard: could not write ${target}: ${message(error)}`, "error");
		return;
	}
	ctx.ui.notify(`jev-guard: wrote ${target}. Edit the rules, then run /jev-guard check <file>.`, "info");
}

async function dryRun(arg: string, ctx: ExtensionCommandContext): Promise<void> {
	const target = arg.trim();
	if (target.length === 0) {
		ctx.ui.notify("usage: /jev-guard check <file>", "warning");
		return;
	}

	const absPath = path.resolve(ctx.cwd, target);
	const display = displayPath(absPath, ctx.cwd);
	let content: string;
	try {
		if (!fs.statSync(absPath).isFile()) throw new Error("not a file");
		content = fs.readFileSync(absPath, "utf8");
	} catch (error) {
		ctx.ui.notify(`jev-guard: cannot read ${absPath}: ${message(error)}`, "error");
		return;
	}

	const chain = loadConfigChain(absPath, ctx.cwd, ctx.isProjectTrusted(), (warning) =>
		ctx.ui.notify(`jev-guard: ${warning}`, "warning"),
	);
	const settings = resolveSettings(chain);
	if (isIgnored(chain, absPath)) {
		ctx.ui.notify(`jev-guard: ${display} is ignored by ${CONFIG_NAME}`, "info");
		return;
	}

	const matched = matchRules(chain, absPath);
	const checks = collectChecks(matched, settings.minProbability);
	if (checks.length === 0) {
		ctx.ui.notify(`jev-guard: no rules match ${display}`, "warning");
		return;
	}

	const limited = limitText(content, settings.maxFileChars);
	const proposed: ProposedContent = {
		file: display,
		scope: "file",
		content: limited.text,
		note: limited.note,
		context: withFileName(display, settings.context, settings.includeFileName),
	};
	const connection = resolveConnection(settings, uniqueDirs([path.dirname(absPath), ctx.cwd]));
	if (!connection.credential) {
		ctx.ui.notify(`jev-guard: ${connection.error ?? "no API key"}`, "error");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `jev: checking ${display}`);
	let outcome: JevOutcome;
	try {
		outcome = await callJev({
			endpoint: connection.endpoint,
			model: connection.model,
			apiKey: connection.credential.value,
			state: proposed,
			checks,
			timeoutMs: settings.timeoutMs,
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	if (!outcome.ok) {
		ctx.ui.notify(`jev-guard: ${outcome.message}`, "error");
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
			`jev-guard check: ${display}`,
			`endpoint: ${connection.endpoint}`,
			`model: ${connection.model}`,
			"",
			...lines,
		].join("\n"),
		"info",
	);
}

// ------------------------------------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------------------------------------

function disabledByEnv(): boolean {
	const value = process.env.JEV_GUARD_DISABLE;
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
