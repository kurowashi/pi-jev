/** Defaults both guards share. They are also the fallbacks in `resolveBaseSettings`. */

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-1.13.0";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_MODEL = "typesafe/jev-1.13";
export const OPENCODE_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
export const OPENCODE_MODEL = "jev-1.13";
export const COMMANDCODE_ENDPOINT = "https://api.commandcode.ai/provider/v1/systemone";
export const COMMANDCODE_MODEL = "typesafe/jev";

export const DEFAULT_MIN_PROBABILITY = 0.5;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_FILE_CHARS = 40_000;

/** API keys that are looked up in the environment and in `.env` files, in order. */
export const KEY_NAMES = [
	"SYSTEMONE_API_KEY",
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
	"OPENCODE_API_KEY",
	"OPENCODE_ZEN_API_KEY",
	"COMMANDCODE_API_KEY",
];
