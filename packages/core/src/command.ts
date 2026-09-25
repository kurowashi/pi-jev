/**
 * Command plumbing: `/x status | init | check | context | on | off`.
 *
 * The dispatch skeleton and the shared output helpers live here; every
 * guard answers with its own status, init, check, and context text.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BaseConfig, LoadedConfig } from "./types.ts";

export interface CommandState {
	isEnabled(): boolean;
	setEnabled(value: boolean): void;
}

export interface CommandHandlers {
	status(ctx: ExtensionCommandContext, state: CommandState): void;
	init(ctx: ExtensionCommandContext): void;
	check(arg: string, ctx: ExtensionCommandContext): Promise<void>;
	context(arg: string, ctx: ExtensionCommandContext): void;
	help(): string;
}

export interface CommandSpec {
	/** Command name without the slash, e.g. "jev-guard". */
	name: string;
	/** Words after the name in the on/off notifications, e.g. "checks". */
	switchLabel: string;
	handlers: CommandHandlers;
}

export async function runCommand(
	args: string,
	ctx: ExtensionCommandContext,
	state: CommandState,
	spec: CommandSpec,
): Promise<void> {
	const [sub = "", ...rest] = args.trim().split(/\s+/);
	switch (sub) {
		case "":
		case "status":
			spec.handlers.status(ctx, state);
			return;
		case "init":
			spec.handlers.init(ctx);
			return;
		case "check":
			await spec.handlers.check(rest.join(" "), ctx);
			return;
		case "context":
			spec.handlers.context(rest.join(" "), ctx);
			return;
		case "on":
			state.setEnabled(true);
			ctx.ui.notify(`${spec.name}: ${spec.switchLabel} enabled`, "info");
			return;
		case "off":
			state.setEnabled(false);
			ctx.ui.notify(`${spec.name}: ${spec.switchLabel} disabled for this session`, "info");
			return;
		default:
			ctx.ui.notify(spec.handlers.help(), "info");
	}
}

/** The top-level context of the adopted config, or a "(none)" line. */
export function contextLines<C extends BaseConfig>(config: LoadedConfig<C> | undefined): string[] {
	if (!config) return ["context: (none)"];
	const value = typeof config.config.context === "string" ? config.config.context.trim() : "";
	if (value.length === 0) return ["context: (none)"];
	return [`context (from ${config.file}):`, ...displayBlock(value)];
}

/** Caps a long state document for command output and points at the full-text command. */
export function clippedText(text: string, command: string, max = 2000): string {
	if (text.length <= max) return text;
	const omitted = text.length - max;
	return `${text.slice(0, max)}\n... (${omitted} characters omitted; run ${command} <file> for the full state)`;
}

export function displayBlock(text: string): string[] {
	return ["----", ...text.split(/\r?\n/), "----"];
}
