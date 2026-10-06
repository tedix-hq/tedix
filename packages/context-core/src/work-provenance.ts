/** Commit attribution copied from an already governed dispatch. This is metadata,
 * not authority: shell users can change their environment and Git hooks. */
export interface WorkProvenance {
	workItemId: string;
	agentSession: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[a-zA-Z0-9_-]+:[^\r\n\t ]{1,299}$/;
const CONTROLS = /[\u0000-\u0020\u007f]/;
const validSession = (value: string) =>
	SESSION.test(value) && value.length <= 300 && !CONTROLS.test(value);
const validItem = (value: string) => value.length === 36 && UUID.test(value);

export function nativeWorkProvenance(
	context: {
		workItemId?: string | null;
		runId?: string | null;
	} | null,
): WorkProvenance | null {
	if (!context?.workItemId) return null;
	const provenance = {
		workItemId: context.workItemId,
		agentSession: `kernel:${context.runId ?? ""}`,
	};
	validateWorkProvenance(provenance);
	return provenance;
}

export function validateWorkProvenance(value: WorkProvenance): void {
	if (!validItem(value.workItemId) || !validSession(value.agentSession)) {
		throw new Error("Invalid Work-Item or Agent-Session commit provenance");
	}
}

/** Append one contiguous trailer block. Existing historical attribution survives
 * amend/rebase/cherry-pick; fresh messages cannot silently claim another run. */
export function stampWorkProvenance(
	message: string,
	provenance: WorkProvenance | null,
	preserveExisting = false,
): string {
	if (!provenance) return message;
	validateWorkProvenance(provenance);
	const paragraphs = message.trimEnd().split(/\r?\n[ \t]*\r?\n/);
	const trailers: string[] = [];
	while (paragraphs.length > 1) {
		const lines = paragraphs.at(-1)!.split(/\r?\n/);
		if (
			!lines.every(
				(line, i) =>
					/^[A-Za-z0-9][A-Za-z0-9-]*:/.test(line) ||
					(i > 0 && /^[ \t]+\S/.test(line)),
			)
		)
			break;
		trailers.unshift(...lines);
		paragraphs.pop();
	}
	for (let index = 1; index < trailers.length; index++) {
		if (
			/^[ \t]/.test(trailers[index]!) &&
			/^(Work-Item|Agent-Session):/i.test(trailers[index - 1]!)
		) {
			throw new Error("Folded commit provenance is malformed");
		}
	}
	const values = (key: string) =>
		trailers.flatMap((line) => {
			const match = line.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "i"));
			return match ? [match[1]!.trim()] : [];
		});
	const items = values("Work-Item");
	const sessions = values("Agent-Session");
	if (
		sessions.length > 1 ||
		new Set(items.map((v) => v.toLowerCase())).size !== items.length ||
		items.some((v) => !validItem(v)) ||
		sessions.some((v) => !validSession(v))
	) {
		throw new Error("Malformed or duplicate commit provenance");
	}
	if (preserveExisting && (items.length || sessions.length)) {
		if (!items.length || !sessions.length)
			throw new Error("Incomplete historical commit provenance");
		return message;
	}
	if (
		items.some(
			(v) => v.toLowerCase() !== provenance.workItemId.toLowerCase(),
		) ||
		sessions.some((v) => v !== provenance.agentSession)
	) {
		throw new Error("Commit provenance conflicts with the captured dispatch");
	}
	if (!items.length) trailers.push(`Work-Item: ${provenance.workItemId}`);
	if (!sessions.length)
		trailers.push(`Agent-Session: ${provenance.agentSession}`);
	return `${paragraphs.join("\n\n")}\n\n${trailers.join("\n")}\n`;
}
