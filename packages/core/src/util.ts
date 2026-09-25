/** Small helpers both guards use. Keep them policy-free. */

import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** True when the given environment variable switches a guard off for this run. */
export function disabledByEnv(variable: string): boolean {
	const value = process.env[variable];
	return value === "1" || value === "true";
}

/** Project-relative POSIX path when the file is inside `cwd`, absolute otherwise. */
export function displayPath(absPath: string, cwd: string): string {
	const relative = path.relative(cwd, absPath);
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return absPath;
	return toPosix(relative);
}

export function isInside(dir: string, filePath: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function uniqueDirs(dirs: string[]): string[] {
	return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

export function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

export function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "";
	}
}

export function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Truncates long text in the middle so the head and the tail both survive.
 * The omitted character count and a note are reported to the caller.
 */
export function limitText(text: string, max: number): { text: string; note?: string } {
	if (text.length <= max) return { text };
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	return {
		text: `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`,
		note: "The content was truncated in the middle to stay within maxFileChars.",
	};
}

export function fenced(text: string, language = ""): string {
	return `\`\`\`${language}\n${text.replace(/\n+$/, "")}\n\`\`\``;
}

export interface WarnOnce {
	/** Notifies at most once per session for each distinct message. */
	warn(ctx: ExtensionContext, message: string): void;
	/** Forgets the already-warned messages (called on session start). */
	reset(): void;
}

/** Builds a `warnOnce` sink whose notifications are prefixed with the guard name. */
export function createWarnOnce(prefix: string): WarnOnce {
	const warned = new Set<string>();
	return {
		warn(ctx, text) {
			if (warned.has(text)) return;
			warned.add(text);
			ctx.ui.notify(`${prefix}: ${text}`, "warning");
		},
		reset() {
			warned.clear();
		},
	};
}
