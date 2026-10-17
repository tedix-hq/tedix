import * as z from "zod";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import { sentenceCase } from "@/lib/format";

const URGENT_LABEL_TEXT: Record<string, string> = {
	blocker_or_failure: "Blocked",
	human_only_action: "Needs you to act",
	risky_action: "Risky action",
};

/** Triage labels in plain words, deduplicated; unknown labels stay readable. */
export function urgentReasons(labels: readonly string[] | undefined) {
	return [...new Set(labels ?? [])].map(
		(label) => URGENT_LABEL_TEXT[label] ?? sentenceCase(label),
	);
}

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
const DECISION_CAPTURE_HOSTS: Record<string, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

const decisionCaptureMetadataSchema = z.object({
	schema: z.literal(DECISION_CAPTURE_SCHEMA),
	host: z.string().optional(),
	sessionId: z.string().optional(),
	repository: z.string().optional(),
	branch: z.string().nullish(),
	triage: z
		.object({
			urgency: z.string().optional(),
			urgentLabels: z.array(z.string()).optional(),
		})
		.optional()
		.catch(undefined),
	/** The server's verdict: `fyi` asks nothing of the user; `need` says what. */
	attention: z
		.object({
			kind: z.enum(["needs_you", "fyi"]),
			need: z.string().nullish(),
		})
		.optional()
		.catch(undefined),
});

/**
 * Where a decision-capture question came from and why it waits, or null for
 * any other Interaction. The question is the agent's own turn-end message in
 * the user's local session, not a message from another person. An `fyi` turn
 * (a status update) is never urgent; `need` is the one-line ask of a turn that
 * needs the user, when the server could write it.
 */
export function decisionCaptureSummary(metadata: unknown) {
	const parsed = decisionCaptureMetadataSchema.safeParse(metadata);
	if (!parsed.success) return null;
	const value = parsed.data;
	const host = value.host
		? (DECISION_CAPTURE_HOSTS[value.host] ?? value.host)
		: "agent";
	const attention = value.attention?.kind ?? null;
	const urgency =
		attention === "fyi"
			? "later"
			: value.triage?.urgency === "now" || value.triage?.urgency === "later"
				? value.triage.urgency
				: null;
	return {
		source: `your ${host} session`,
		origin: [`From your ${host} session`, value.repository, value.branch]
			.filter((part): part is string => Boolean(part))
			.join(" · "),
		sessionId: value.sessionId,
		shortSessionId: value.sessionId?.slice(0, 8),
		urgency,
		reasons: urgency === "now" ? urgentReasons(value.triage?.urgentLabels) : [],
		attention,
		need:
			attention === "needs_you" ? value.attention?.need?.trim() || null : null,
	};
}

/**
 * The subject as plain text. For a captured turn that needs the user, its
 * one-line need ("What's needed from you") replaces the agent's first line.
 * Decision-capture subjects come from the agent's Markdown; rows written
 * before the CLI stripped it still carry the markers.
 */
export function interactionSubject(request: {
	subject: string;
	metadata?: unknown;
}) {
	const summary = decisionCaptureSummary(request.metadata);
	if (!summary) return request.subject;
	return (
		summary.need || markdownLineToPlainText(request.subject) || request.subject
	);
}

/**
 * The one line a person needs: the interaction's "What's needed from you"
 * when it carries one, else its subject without the "repo · host waiting:"
 * prefix every decision-capture subject starts with.
 */
export function officeAsk(request: {
	subject: string;
	metadata?: unknown;
	neededFromYou?: unknown;
}): string {
	const meta =
		typeof request.metadata === "object" && request.metadata !== null
			? (request.metadata as Record<string, unknown>)
			: {};
	const needed = request.neededFromYou ?? meta.neededFromYou;
	if (typeof needed === "string" && needed.trim()) return needed.trim();
	const subject = interactionSubject(request);
	return subject.replace(/^[^:]{0,80}\bwaiting:\s*/i, "") || subject;
}
