import { asRecord } from "./is-record";

export interface ApprovalDecision {
	/** The action in one plain sentence. */
	what: string;
	/** The exact inputs that matter, as short "Label: value" parts; empty when none. */
	details: string[];
	whyNow: string;
	ifApproved: string;
	ifRejected: string;
	recommendation: "approved" | "rejected";
	reason: string;
}

/** The note the MCP gateway appends to every parked tool call, old and new wording. */
const RETRY_PHRASE = /Nothing has run yet;|After deciding in Tedix OS,/i;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const WHITESPACE = /\s/;

// The parsers below replace regexes with nested quantifiers that backtrack
// quadratically on crafted descriptions; each keeps the regex's exact result.

function lastLineTerminator(text: string): number {
	for (let i = text.length - 1; i >= 0; i--) {
		if (LINE_TERMINATOR.test(text.charAt(i))) return i;
	}
	return -1;
}

function isSpace(text: string, index: number): boolean {
	return WHITESPACE.test(text.charAt(index));
}

/**
 * Drops the gateway's retry note and the rest of its line, with the whitespace
 * and one period before it. Equivalent to replacing
 * `/\.?\s*(?:Nothing has run yet;|After deciding in Tedix OS,).*$/i`.
 */
export function stripRetryNote(text: string): string {
	const tail = lastLineTerminator(text) + 1;
	const found = text.slice(tail).search(RETRY_PHRASE);
	if (found < 0) return text;
	let start = tail + found;
	while (start > 0 && isSpace(text, start - 1)) start--;
	if (start > 0 && text.charAt(start - 1) === ".") start--;
	return text.slice(0, start);
}

/** Equivalent to replacing `/\s+—\s+.*$/` with "". */
export function stripDashTail(text: string): string {
	const last = lastLineTerminator(text);
	for (
		let dash = text.indexOf("—");
		dash >= 0;
		dash = text.indexOf("—", dash + 1)
	) {
		if (dash === 0 || !isSpace(text, dash - 1)) continue;
		let end = dash + 1;
		while (end < text.length && isSpace(text, end)) end++;
		if (end === dash + 1 || end <= last) continue;
		let start = dash - 1;
		while (start > 0 && isSpace(text, start - 1)) start--;
		return text.slice(0, start);
	}
	return text;
}

const SKILL_PREFIX = "Run skill: ";
const SKILL_NOTE = ". Nothing has run yet;";

/**
 * The skill name and optional "In …." detail of a parked skill run. Same
 * captures as `/^Run skill: (.+?)\.(?: (In .+?\.))? Nothing has run yet;/`.
 */
export function parseSkillRunDescription(
	description: string,
): { name: string; detail: string | null } | null {
	if (!description.startsWith(SKILL_PREFIX)) return null;
	const lineEnd = description.search(LINE_TERMINATOR);
	const line = lineEnd < 0 ? description : description.slice(0, lineEnd);
	const first = SKILL_PREFIX.length + 1;
	const notes: number[] = [];
	for (
		let at = line.indexOf(SKILL_NOTE, first);
		at >= 0;
		at = line.indexOf(SKILL_NOTE, at + 1)
	) {
		notes.push(at);
	}
	let next = 0;
	for (let dot = first; dot < line.length; dot++) {
		if (line.charAt(dot) !== ".") continue;
		const name = line.slice(SKILL_PREFIX.length, dot);
		if (line.startsWith(". In ", dot)) {
			// "In " plus at least one character before the closing period.
			while (next < notes.length && (notes[next] ?? 0) < dot + 6) next++;
			const end = notes[next];
			if (end !== undefined) {
				return { name, detail: line.slice(dot + 2, end + 1) };
			}
		}
		if (line.startsWith(SKILL_NOTE, dot)) return { name, detail: null };
	}
	return null;
}

const CREDENTIAL_TARGET = /api[-_ ]?key|token|secret|credential|password/i;

const SKIPPED_ARG = /(?:^|_)(?:id|ids)$|Id$|Ids$|^organization|^fingerprint$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-.]+/g, " ")
		.trim()
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function clip(value: string, max = 80): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Up to four "Label: value" parts from a tool call's arguments, so a person
 * reads what the call would do without opening the raw request. Identifiers
 * and nested objects stay in the technical details.
 */
export function approvalArgumentSummary(args: unknown, limit = 4): string[] {
	const record = asRecord(args);
	if (!record) return [];
	const parts: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (parts.length >= limit) break;
		if (SKIPPED_ARG.test(key)) continue;
		if (typeof value === "string") {
			if (!value.trim() || UUID.test(value.trim())) continue;
			parts.push(`${label(key)}: ${clip(value)}`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			parts.push(
				`${label(key)}: ${value === true ? "yes" : value === false ? "no" : value}`,
			);
		} else if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((item) => typeof item === "string")
		) {
			parts.push(`${label(key)}: ${clip(value.join(", "))}`);
		} else if (Array.isArray(value) && value.length > 0) {
			const first = asRecord(value[0]);
			const name =
				typeof first?.title === "string"
					? first.title
					: typeof first?.name === "string"
						? first.name
						: null;
			parts.push(
				`${label(key)}: ${value.length}${name ? ` (first: ${clip(name, 60)})` : ""}`,
			);
		}
	}
	return parts;
}

/** The action named by a parked request's description, without the retry note. */
export function approvalActionTitle(description: string | undefined): string {
	const title = stripRetryNote(description ?? "").trim();
	return title.endsWith(".") ? title.slice(0, -1) : title;
}

/** Unknown actions keep their technical request visible without inventing consequences. */
export function approvalDecision(input: {
	actionType: string;
	review: { intent: string };
	description?: string;
	payload?: Record<string, unknown>;
	/** The classified risk of a parked Home write; absent for other requests. */
	riskTier?: string | null;
}): ApprovalDecision {
	const target = asRecord(input.payload?.target);
	const args = asRecord(input.payload?.args);
	const details = approvalArgumentSummary(args);
	if (
		input.actionType === "mcp.tool_call" &&
		input.payload?.kind === "mcp_tool_call" &&
		target?.transport === "rpc" &&
		target.endpoint === "skills/runWorkflow"
	) {
		const title = parseSkillRunDescription(input.description ?? "");
		const name = title?.name.replace(/ improvement [a-f0-9]+$/i, "");
		const probe = asRecord(args?.params)?.probe === true;
		return {
			what: probe
				? `Run a test of ${name ? `the ${name}` : "the saved"} skill proposal.`
				: `Run ${name ? `the ${name}` : "the saved"} skill.`,
			details: title?.detail ? [title.detail] : [],
			whyNow: "The skill run was stopped before it started.",
			ifApproved:
				"Tedix starts this exact skill run once for the person who asked and records the result here. It does not activate the proposal.",
			ifRejected: "The skill does not run.",
			recommendation: "rejected",
			reason:
				"Review the skill and its saved parameters before allowing the run.",
		};
	}
	if (
		input.actionType === "mcp.tool_call" &&
		input.payload?.kind === "mcp_tool_call"
	) {
		const title = approvalActionTitle(input.description);
		const tool =
			typeof target?.endpoint === "string"
				? target.endpoint
				: typeof target?.mcpToolName === "string"
					? target.mcpToolName
					: null;
		const credential = CREDENTIAL_TARGET.test(`${tool ?? ""} ${title}`);
		return {
			what: title ? `${title}.` : "Run a tool call Tedix can't describe.",
			details: [...details, ...(tool ? [`Tool: ${tool}`] : [])],
			whyNow: "The call was stopped before it ran.",
			ifApproved:
				"Tedix runs this exact call once for the person who asked and records the result here. Nothing else is allowed.",
			ifRejected: "The call does not run.",
			recommendation: "rejected",
			reason: !title
				? "Tedix can't describe this action, so it's safer to reject."
				: credential
					? "This creates or changes a credential. Approve only if you or your agent started it."
					: "Check the inputs before allowing this call.",
		};
	}
	const riskTier =
		input.riskTier ??
		(typeof input.payload?.riskTier === "string"
			? input.payload.riskTier
			: null);
	if (
		input.review.intent === "home_write" ||
		(input.review.intent === "tool_write" &&
			input.payload?.kind === "home_tool_write")
	) {
		const low = riskTier === "low";
		const title = stripDashTail(approvalActionTitle(input.description));
		return {
			what: title ? `${title}.` : "Make the change shown in the details.",
			details,
			whyNow: "Home is paused until you decide or the request expires.",
			ifApproved: "The change runs once, exactly as shown.",
			ifRejected: "Nothing changes.",
			recommendation: low ? "approved" : "rejected",
			reason: low
				? "Low-risk change inside Tedix; check the target and new value, then approve."
				: riskTier === "high"
					? "High-risk change: check every input before approving."
					: "Confirm the target and change in the details before allowing it.",
		};
	}
	const catalog: Record<
		string,
		Omit<ApprovalDecision, "whyNow" | "details">
	> = {
		home_request: {
			what: "Let Home continue its saved request.",
			ifApproved:
				"Home continues the saved action, work order or plan shown in the details.",
			ifRejected: "Home cancels this request without starting it.",
			recommendation: "rejected",
			reason:
				"Review the saved scope and effects before starting work or making a change.",
		},
		tool_write: {
			what: "Let the tedi carry out its saved change.",
			ifApproved: "The saved change runs once, exactly as shown.",
			ifRejected: "The saved change is cancelled without running.",
			recommendation: "rejected",
			reason:
				"Confirm the target and change in the details before allowing a write.",
		},
		browser_takeover: {
			what: "Complete a sign-in or consent step in the tedi's browser.",
			ifApproved: "The tedi continues in that browser session.",
			ifRejected: "The tedi stops waiting for this browser step.",
			recommendation: "rejected",
			reason:
				"Sign-in and consent need your presence before the tedi continues.",
		},
		workstation_attach: {
			what: "Start work in the selected development environment.",
			ifApproved: "The selected environment is attached and work can start.",
			ifRejected: "The environment is not attached.",
			recommendation: "rejected",
			reason: "Review the environment and scope before starting work.",
		},
	};
	const title = approvalActionTitle(input.description);
	return {
		...(catalog[input.review.intent] ?? {
			what: title ? `${title}.` : "Tedix can't describe this action.",
			ifApproved: "The requester may do this once.",
			ifRejected: "The requester does not get permission.",
			recommendation: "rejected" as const,
			reason: "Tedix can't describe this action, so it's safer to reject.",
		}),
		details,
		whyNow: "The tedi is paused until you decide or the request expires.",
	};
}
