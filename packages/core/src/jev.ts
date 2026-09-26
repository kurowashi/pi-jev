/**
 * The Jev (TypeSafe System One) request.
 *
 * One request per tool call: every matching rule's checks and context are
 * merged. The state document is built by the caller, because its shape depends
 * on what is being checked; only the prompt wrapper lives here.
 */

import type { JevOutcome, PendingCheck } from "./types.ts";
import { message } from "./util.ts";

export interface JevRequest {
	endpoint: string;
	model: string;
	apiKey: string;
	/** The state document sent to Jev, built by the caller. */
	state: string;
	/** How the state is described in the prompt, e.g. "the file's complete proposed content". */
	describeState: string;
	/** What Jev answers about, e.g. "new content" or "new file". */
	subject: string;
	checks: PendingCheck[];
	timeoutMs: number;
}

/** The Jev question for one pending check. */
function questionFor(check: PendingCheck, subject: string, describeState: string): Record<string, unknown> {
	const ask = check.negate
		? `Answer yes if the following statement describes the ${subject}: ${check.text}`
		: `Answer yes if the ${subject} satisfies this requirement: ${check.text}`;
	const criteria = check.negate
		? {
				true: `The statement describes the ${subject}.`,
				false: `The statement does not describe the ${subject}.`,
			}
		: { true: "The requirement is satisfied.", false: "The requirement is violated." };
	return {
		type: "noul",
		instructions: `The state contains ${describeState}. ${ask}`,
		criteria,
	};
}

export async function callJev(request: JevRequest): Promise<JevOutcome> {
	const questions: Record<string, unknown> = {};
	for (const check of request.checks) {
		questions[check.name] = questionFor(check, request.subject, request.describeState);
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

export function describeFetchError(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `Jev did not answer within ${timeoutMs} ms.`;
	}
	return `Jev request failed: ${message(error)}`;
}

export function statusHint(status: number): string {
	if (status === 400)
		return " (check the request size: state and the longest question must fit the model's token budget)";
	if (status === 401 || status === 403) return " (check the API key)";
	if (status === 402) return " (payment required)";
	if (status === 404 || status === 405 || status === 410) return " (check the endpoint URL)";
	if (status === 408) return " (request timed out)";
	if (status === 429) return " (rate limited)";
	if (status >= 500) return " (service unavailable)";
	return "";
}
