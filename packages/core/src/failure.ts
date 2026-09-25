/** Turning Jev probabilities into a verdict and into the text the model sees. */

import * as path from "node:path";
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { BaseConfig, MatchedRule, OnError, PendingCheck } from "./types.ts";

/**
 * Probability that a check's requirement is satisfied. A negated check states
 * the failure mode, so Jev's probability of the statement is inverted.
 */
export function satisfiedProbability(check: PendingCheck, raw: number): number {
	return check.negate ? 1 - raw : raw;
}

/**
 * Groups the failed checks by rule and renders each rule's `fail` template
 * (or the guard's own fallback) into the reason returned to the model.
 */
export function buildFailureReason<C extends BaseConfig>(
	failures: PendingCheck<C>[],
	probabilities: Map<string, number>,
	settings: { fail?: string },
	file: string,
	fallback: (file: string, details: string) => string,
): string {
	const byRule = new Map<MatchedRule<C>, PendingCheck<C>[]>();
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
			blocks.push(fallback(file, details));
		}
	}
	return blocks.join("\n\n");
}

export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export function percent(probability: number): string {
	return `${Math.round(probability * 100)}%`;
}

/** Guard identity used in the messages core renders. */
export interface GuardFlavor {
	/** Status/notification prefix, e.g. "jev-guard". */
	name: string;
	/** Config file name, e.g. ".jev-guard.json". */
	configName: string;
	/** Label in "Jev check could not run", e.g. "Jev check" or "Jev placement check". */
	checkLabel: string;
	/** Tool noun used in messages, e.g. "edit" or "write". */
	action: string;
}

/**
 * Fails open (warn once) or closed (block with a reason) when no check could
 * run at all, according to `onError`.
 */
export function handleCheckError(
	settings: { onError: OnError },
	ctx: ExtensionContext,
	flavor: GuardFlavor,
	message: string,
	display: string,
	warn: (message: string) => void,
): ToolCallEventResult | undefined {
	if (settings.onError === "block") {
		ctx.ui.notify(`${flavor.name}: ${message}`, "error");
		return {
			block: true,
			reason: `${flavor.checkLabel} could not run for ${display}: ${message}.\nSet "onError": "allow" in ${flavor.configName} to let ${flavor.action}s through when Jev is unavailable.`,
		};
	}
	warn(`${message} (${flavor.action} allowed)`);
	return undefined;
}

/** Label used in `{rule}` and in the failure output. */
export function ruleLabel<C extends BaseConfig>(rule: MatchedRule<C>): string {
	return rule.rule.name ?? path.basename(rule.config.file);
}
