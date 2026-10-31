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

/** Only canonical epoch/attempt call paths can identify an immutable parent. */
export function parentStepCoordinates(event: SkillWorkflowTimelineEvent) {
	if (event.kind !== "mcp" && event.kind !== "network") return null;
	const match =
		/^(epochs\/(0|[1-9]\d*)\/steps\/([^/]+)\/([1-9]\d*)\/attempts\/([1-9]\d*))\/(calls|network)\/(run|rollback)\/([1-9]\d*)\.json$/.exec(
			event.path,
		);
	if (
		!match ||
		Number(match[2]) !== event.executionEpoch ||
		Number(match[5]) !== event.attempt ||
		(event.kind === "mcp" ? match[6] !== "calls" : match[6] !== "network") ||
		(event.phase && event.phase !== match[7])
	)
		return null;
	try {
		const encoded = match[3]!;
		const name = decodeURIComponent(
			encoded.startsWith("x:") ? encoded.slice(2) : encoded,
		);
		if (name !== event.name) return null;
		return {
			path: `${match[1]}.json`,
			name,
			stepCount: Number(match[4]),
			attempt: Number(match[5]),
			phase: match[7],
			ordinal: Number(match[8]),
		};
	} catch {
		return null;
	}
}

/** Match both saved receipts before exposing author-declared parent metadata. */
export function matchedParentStep(
	event: SkillWorkflowTimelineEvent,
	child: Record<string, unknown>,
	parent: Record<string, unknown>,
) {
	const coordinates = parentStepCoordinates(event);
	if (!coordinates) return false;
	const childStep = stepRecord(child.step);
	const parentStep = stepRecord(parent.step);
	return (
		parent.kind === "workflow_step_attempt" &&
		parent.executionEpoch === event.executionEpoch &&
		parent.attempt === coordinates.attempt &&
		parentStep.name === coordinates.name &&
		parentStep.count === coordinates.stepCount &&
		child.kind ===
			(event.kind === "mcp" ? "workflow_mcp_call" : "workflow_network_call") &&
		child.executionEpoch === event.executionEpoch &&
		child.attempt === coordinates.attempt &&
		child.phase === coordinates.phase &&
		child.ordinal === coordinates.ordinal &&
		childStep.name === coordinates.name &&
		childStep.count === event.count &&
		(typeof childStep.id !== "string" ||
			typeof parentStep.id !== "string" ||
			childStep.id === parentStep.id) &&
		(event.kind === "mcp"
			? typeof event.namespace === "string" &&
				child.namespace === event.namespace &&
				typeof event.method === "string" &&
				child.method === event.method
			: typeof event.host === "string" &&
				child.host === event.host &&
				typeof event.method === "string" &&
				child.method === event.method)
	);
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

/** Separate result-envelope bookkeeping without hiding distinct result data. */
export function presentStepResult(value: unknown): {
	content: unknown;
	technical: Record<string, unknown>;
} {
	const record = stepRecord(value);
	const data = stepRecord(record.data);
	const hasResultList =
		Array.isArray(data.web) ||
		Array.isArray(record.web) ||
		Array.isArray(record.results);
	if (!hasResultList) return { content: value, technical: {} };
	const content = { ...record };
	const technical: Record<string, unknown> = {};
	for (const key of ["id", "agentHints", "agent_hints", "creditsUsed"]) {
		if (key === "id" && typeof record.success !== "boolean") continue;
		if (key in content) {
			technical[key] = content[key];
			delete content[key];
		}
	}
	const results = Array.isArray(data.web)
		? data.web
		: Array.isArray(record.web)
			? record.web
			: record.results;
	if (
		Array.isArray(record.tools) &&
		JSON.stringify(record.tools) === JSON.stringify(results)
	) {
		technical.tools = record.tools;
		delete content.tools;
	}
	if (
		Array.isArray(data.web) &&
		Array.isArray(data.tools) &&
		data.tools.every((item) => {
			const suggestion = stepRecord(item);
			return (
				typeof suggestion.provider === "string" &&
				typeof suggestion.capability === "string" &&
				(suggestion.description === undefined ||
					typeof suggestion.description === "string") &&
				Object.keys(suggestion).every((key) =>
					["provider", "capability", "description"].includes(key),
				)
			);
		})
	) {
		technical.suggestedTools = data.tools;
		const visibleData = { ...data };
		delete visibleData.tools;
		content.data = visibleData;
	}
	return { content, technical };
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
