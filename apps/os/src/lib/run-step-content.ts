import type { SkillWorkflowTimelineEvent } from "@tedix/api-contract/schemas/cognitive";

export function stepTitle(event: SkillWorkflowTimelineEvent) {
	if (event.method === "run_tedi_turn") return "Ask an assistant";
	if (event.method === "messages_read" || event.method === "read_messages")
		return "Read assistant replies";
	if (event.kind === "step") return readableField(event.name);
	if (event.kind === "sleep" || event.kind === "wait")
		return "Waiting for a reply";
	if (event.kind === "network") return "Web request";
	return readableField(event.method ?? event.name);
}

export function stepRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** A redaction marker anywhere in a snapshot makes that snapshot unsafe to render. */
export function hasRedaction(value: unknown, depth = 0): boolean {
	if (value === null || typeof value !== "object") return false;
	if (depth >= 12) return true;
	if (stepRecord(value).redacted === true) return true;
	return Object.values(value).some((child) => hasRedaction(child, depth + 1));
}

/** Unwrap transport envelopes, retaining the assistant's recorded answer. */
export function readableStepResult(value: unknown, depth = 0): unknown {
	if (depth >= 8) return value;
	if (typeof value === "string") {
		const text = value
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "");
		if (text.length <= 64000 && /^[\[{]/.test(text)) {
			try {
				return readableStepResult(JSON.parse(text), depth + 1);
			} catch {
				/* Keep non-JSON replies as text. */
			}
		}
		return value;
	}
	const record = stepRecord(value);
	const assistant = stepRecord(record.assistant);
	if (typeof assistant.content === "string")
		return readableStepResult(assistant.content, depth + 1);
	if (typeof record.text === "string" && typeof record.ok === "boolean")
		return readableStepResult(record.text, depth + 1);
	if ("value" in record && ("ok" in record || "truncated" in record))
		return readableStepResult(record.value, depth + 1);
	return value;
}

export function stepConversation(...values: unknown[]) {
	const visit = (
		value: unknown,
		depth: number,
	): { tediId: string; conversationId: string } | null => {
		if (depth > 7) return null;
		const r = stepRecord(value);
		const conversationId = r.conversationId;
		const runId = r.runId ?? r.run_id ?? stepRecord(r.task).id;
		const tediId =
			typeof r.tediId === "string"
				? r.tediId
				: typeof runId === "string"
					? /^(?:tedi:)?([0-9a-f]{8}-[0-9a-f-]{27}):/i.exec(runId)?.[1]
					: undefined;
		if (typeof conversationId === "string" && tediId)
			return { tediId, conversationId };
		for (const key of ["value", "response", "request", "task"]) {
			if (key in r) {
				const found = visit(r[key], depth + 1);
				if (found) return found;
			}
		}
		return null;
	};
	for (const value of values) {
		const found = visit(value, 0);
		if (found) return found;
	}
	return null;
}

export function readableField(key: string) {
	const text = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Numeric identifiers are not dates unless their field supplies that meaning. */
export function stepTimestamp(value: unknown, field?: string): string | null {
	if (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		)
	)
		return Number.isNaN(Date.parse(value)) ? null : value;
	if (
		!field ||
		!/^(?:timestamp|time|clock|(?:created|updated|started|ended|completed|finished|recorded|saved|expires)[_-]?(?:at|time))$/i.test(
			field,
		)
	)
		return null;
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{10,13}$/.test(value)
				? Number(value)
				: NaN;
	const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
	return ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1)
		? new Date(ms).toISOString()
		: null;
}

export function recordingNote(warning: string): string {
	const count = /^(\d+) /.exec(warning)?.[1];
	if (
		count &&
		/artifact body\/bodies.*(?:inspection limit|inspection budget)/.test(
			warning,
		)
	)
		return `${count} saved records were not loaded because this page reached its loading limit. Select a step to load its saved result separately.`;
	if (count && /artifact body\/bodies were missing/.test(warning))
		return `${count} saved records could not be found. Some step details may be unavailable.`;
	if (count && /artifact body\/bodies were unavailable/.test(warning))
		return `${count} saved records could not be loaded because their storage is unavailable.`;
	return "Some saved details could not be read. Open recording details for the original message.";
}
