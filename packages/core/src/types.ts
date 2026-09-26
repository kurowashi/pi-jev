/** Types shared by the guards. `BaseConfig` and `BaseSettings` hold only keys both guards use. */

export type OnError = "allow" | "block";

export interface CheckSpec {
	/** The requirement to check. */
	check?: string;
	/** Minimum probability of "yes" for the check to pass. */
	minProbability?: number;
	/**
	 * Set to true when `check` names the failure mode instead of the requirement.
	 * Jev answers the statement as written and the probability is inverted, so
	 * "dirty code" can be used instead of "No dirty code".
	 */
	negate?: boolean;
}

export interface RuleConfig {
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

/**
 * Config keys both guards understand. Each guard extends this with the keys
 * that only make sense for its own kind of check.
 */
export interface BaseConfig {
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
	rules?: RuleConfig[];
}

/** Settings both guards share, resolved from the config chain. */
export interface BaseSettings {
	enabled: boolean;
	endpoint?: string | undefined;
	model?: string | undefined;
	apiKeyEnv?: string | undefined;
	minProbability: number;
	onError: OnError;
	includeFileName: boolean;
	maxFileChars: number;
	timeoutMs: number;
	fail?: string | undefined;
	context?: string | undefined;
}

export interface LoadedConfig<C = BaseConfig> {
	file: string;
	/** Directory that `files` patterns are relative to. */
	baseDir: string;
	config: C;
}

export interface MatchedRule<C = BaseConfig> {
	rule: RuleConfig;
	config: LoadedConfig<C>;
}

export interface PendingCheck<C = BaseConfig> {
	name: string;
	text: string;
	minProbability: number;
	negate: boolean;
	rule: MatchedRule<C>;
}

export interface Credential {
	name: string;
	value: string;
	source: string;
}

export type JevOutcome = { ok: true; probabilities: Map<string, number> } | { ok: false; message: string };
