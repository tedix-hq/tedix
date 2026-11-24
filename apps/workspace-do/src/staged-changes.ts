/**
 * Staged changes: the pending layer of one conversation. In "Ask every time"
 * and "Ask for changes" a write a signed-in person's turn makes to a
 * workspace file or a Work Item is staged here instead of waiting on a card
 * (see `stagesCall` in `approval-modes.ts`). The agent's later reads in the
 * same conversation see the staged state; nobody else does, and nothing real
 * changes until the person accepts it on the conversation's review card.
 *
 * Each staged change is also an approval row that holds the exact call
 * accepting it runs (`outputs.revise` at the pinned base revision,
 * `outputs.create`, or the Work call as asked), so accepting goes through the
 * same gate, receipt and change ledger as any approved card.
 */
import { evaluateCall } from "@tedix/agent-governance/compliance";
import {
	type AccountabilityAdapter,
	CHANGE_RECORD_SCHEMA_VERSION,
	type ChangeRecord,
	type ComplianceAdapter,
} from "@tedix/agent-governance/types";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OutputDetail,
	OutputSummary,
	WorkItemDetail,
	WorkItemSummary,
	WorkspaceDataPort,
	WorkspaceRunPort,
} from "./data-port";
import type { WorkspaceStorage } from "./runtime";

export const STAGED_SCHEMA = `
CREATE TABLE IF NOT EXISTS staged_changes (
	approval_id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	target_id TEXT NOT NULL,
	creates INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,
	base_revision INTEGER,
	edits INTEGER NOT NULL DEFAULT 1,
	state TEXT NOT NULL,
	depends_on TEXT,
	result_id TEXT,
	staged_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS staged_changes_target ON staged_changes(conversation_id, target_id);
`;

/** A staged change nobody decided expires this long after its last edit. */
export const STAGED_TTL_MS = 24 * 60 * 60_000;

/** Ids of what a staged change creates; they exist only in this conversation. */
export const STAGED_OUTPUT_PREFIX = "staged-output-";
export const STAGED_WORK_PREFIX = "staged-work-";

/** Said with every staged result, so the agent never reports it as done. */
export const STAGED_NOTE =
	"Staged, not applied: the person accepts or rejects this on the review card in this chat. Only this conversation sees it; never say it is done or saved.";

/** A write outside staging to something with a staged change in this chat. */
export const STAGED_CONFLICT =
	"This has a staged change in this chat that the person has not accepted or rejected yet. Nothing was changed; the change waits until the staged one is accepted or discarded on the review card.";

export type StagedKind = "output" | "work";

export interface StagedRow {
	approval_id: string;
	conversation_id: string;
	kind: StagedKind;
	target_id: string;
	creates: number;
	title: string;
	base_revision: number | null;
	edits: number;
	state: string;
	depends_on: string | null;
	result_id: string | null;
	staged_at: string;
	expires_at: string;
	/** From the approval row. */
	status: string;
}

/** What a staged file shows to the conversation that staged it. */
export interface StagedOutputState {
	output: OutputDetail;
}

/** A staged Work call: the input as the agent asked. */
export interface StagedWorkState {
	method: "create" | "comment" | "accept";
	input: Record<string, unknown>;
}

const SELECT = `SELECT s.*, a.status AS status FROM staged_changes s JOIN approvals a ON a.approval_id = s.approval_id`;

export class StagedChanges {
	constructor(private readonly storage: WorkspaceStorage) {
		storage.run(STAGED_SCHEMA);
	}

	get(approvalId: string): StagedRow | undefined {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.approval_id = ?`,
			approvalId,
		)[0];
	}

	/** Staged changes of a conversation still waiting for the person. */
	pending(conversationId: string): StagedRow[] {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.conversation_id = ? AND a.status = 'pending' ORDER BY s.rowid ASC`,
			conversationId,
		);
	}

	/** The waiting staged change of one file or Work Item in a conversation. */
	pendingFor(
		conversationId: string,
		targetId: string,
		kind: StagedKind,
	): StagedRow | undefined {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.conversation_id = ? AND s.target_id = ? AND s.kind = ? AND a.status = 'pending' ORDER BY s.rowid ASC LIMIT 1`,
			conversationId,
			targetId,
			kind,
		)[0];
	}

	/** The staged change that creates `targetId`, whatever became of it. */
	creating(conversationId: string, targetId: string): StagedRow | undefined {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.conversation_id = ? AND s.target_id = ? AND s.creates = 1 LIMIT 1`,
			conversationId,
			targetId,
		)[0];
	}

	/** Waiting changes that build on `approvalId`. */
	dependents(approvalId: string): StagedRow[] {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.depends_on = ? AND a.status = 'pending' ORDER BY s.rowid ASC`,
			approvalId,
		);
	}

	/** Waiting changes of a conversation past their expiry. */
	expired(conversationId: string, now: string): StagedRow[] {
		return this.storage.exec<StagedRow>(
			`${SELECT} WHERE s.conversation_id = ? AND a.status = 'pending' AND s.expires_at <= ? ORDER BY s.rowid ASC`,
			conversationId,
			now,
		);
	}

	insert(row: Omit<StagedRow, "status" | "result_id">): void {
		this.storage.run(
			"INSERT INTO staged_changes (approval_id, conversation_id, kind, target_id, creates, title, base_revision, edits, state, depends_on, staged_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			row.approval_id,
			row.conversation_id,
			row.kind,
			row.target_id,
			row.creates,
			row.title,
			row.base_revision,
			row.edits,
			row.state,
			row.depends_on,
			row.staged_at,
			row.expires_at,
		);
	}

	/** One more edit to the same staged file: its state and expiry move on. */
	fold(
		approvalId: string,
		update: { title: string; state: string; expiresAt: string },
	): void {
		this.storage.run(
			"UPDATE staged_changes SET title = ?, state = ?, edits = edits + 1, expires_at = ? WHERE approval_id = ?",
			update.title,
			update.state,
			update.expiresAt,
			approvalId,
		);
	}

	/** What an accepted create made: later changes and reads use its real id. */
	setResult(approvalId: string, resultId: string): void {
		this.storage.run(
			"UPDATE staged_changes SET result_id = ? WHERE approval_id = ?",
			resultId,
			approvalId,
		);
	}
}

/** One write a staged binding call made to the pending layer. */
export type StagedWrite =
	| {
			op: "revise";
			outputId: string;
			/** The real revision the first staged edit read. */
			baseRevision: number;
			output: OutputDetail;
	  }
	| { op: "create"; outputId: string; output: OutputDetail };

/** Collects the writes of one binding call run against the pending layer. */
export interface StagedCapture {
	writes: StagedWrite[];
}

function stagedOutput(row: StagedRow): OutputDetail {
	return (JSON.parse(row.state) as StagedOutputState).output;
}

function stagedWork(row: StagedRow): StagedWorkState {
	return JSON.parse(row.state) as StagedWorkState;
}

/** A staged Work Item as `work.list` shows it. */
export function stagedWorkSummary(row: StagedRow): WorkItemSummary {
	const input = stagedWork(row).input;
	return {
		id: row.target_id,
		title: row.title,
		disposition: "staged",
		workKind: typeof input.workKind === "string" ? input.workKind : "other",
		priority: typeof input.priority === "string" ? input.priority : null,
		projectId: typeof input.projectId === "string" ? input.projectId : null,
		updatedAt: row.staged_at,
	};
}

/**
 * The conversation's view of the data port. Reads show its staged changes.
 * With `capture`, file writes go to the pending layer and nothing else may
 * write; without it, writes pass through, except to something with a
 * staged change waiting, which is refused rather than overwritten.
 */
export function stagedDataPort<P extends WorkspaceDataPort & WorkspaceRunPort>(
	port: P,
	staged: StagedChanges,
	conversationId: string,
	capture?: StagedCapture,
): P {
	const pendingOutput = (outputId: string) =>
		staged.pendingFor(conversationId, outputId, "output");
	/** An accepted staged create stands for the item it made. */
	const realId = (id: string) =>
		id.startsWith(STAGED_OUTPUT_PREFIX) || id.startsWith(STAGED_WORK_PREFIX)
			? (staged.creating(conversationId, id)?.result_id ?? id)
			: id;
	const getOutput = async (outputId: string): Promise<OutputDetail | null> => {
		const id = realId(outputId);
		const row = pendingOutput(id);
		if (row)
			return { ...stagedOutput(row), staged: STAGED_NOTE } as OutputDetail;
		if (id.startsWith(STAGED_OUTPUT_PREFIX)) return null;
		return port.getOutput(id);
	};
	const overrides: Partial<WorkspaceDataPort & WorkspaceRunPort> = {
		getOutput,
		listOutputs: async (options) => {
			const rows = staged
				.pending(conversationId)
				.filter((row) => row.kind === "output");
			const real = await port.listOutputs(options);
			const byId = new Map(rows.map((row) => [row.target_id, row]));
			const summary = (output: OutputDetail): OutputSummary => {
				const { content: _content, ...rest } = output;
				return { ...rest, staged: STAGED_NOTE } as OutputSummary;
			};
			const listed = real.map((item) => {
				const row = byId.get(item.id);
				return row ? summary(stagedOutput(row)) : item;
			});
			const created = rows
				.filter((row) => row.creates === 1)
				.map((row) => stagedOutput(row))
				.filter(
					(output) =>
						(!options?.kind || output.kind === options.kind) &&
						(!options?.status || options.status === "active"),
				)
				.map(summary);
			return [...created, ...listed];
		},
		reviseOutput: async (input) => {
			const id = realId(input.outputId);
			if (!capture) {
				if (pendingOutput(id) || id.startsWith(STAGED_OUTPUT_PREFIX))
					throw new Error(STAGED_CONFLICT);
				return port.reviseOutput({ ...input, outputId: id });
			}
			const row = pendingOutput(id);
			const current = await getOutput(id);
			if (!current) throw new Error("Output not found or unavailable");
			if (current.revision !== input.expectedRevision)
				throw new Error(
					`revision_conflict: ${row ? "with your staged changes " : ""}the file is at revision ${current.revision}; read it again and edit that revision. Nothing was staged.`,
				);
			const output: OutputDetail = {
				...current,
				content: input.content,
				kind: input.content.kind as OutputDetail["kind"],
				revision: current.revision + 1,
				revisionId: null,
				updatedAt: new Date().toISOString(),
			};
			delete (output as { staged?: unknown }).staged;
			capture.writes.push(
				row?.creates === 1
					? { op: "create", outputId: id, output }
					: {
							op: "revise",
							outputId: id,
							baseRevision: row?.base_revision ?? current.revision,
							output,
						},
			);
			return { ...output, staged: STAGED_NOTE } as OutputDetail;
		},
		createOutput: async (input) => {
			if (!capture) return port.createOutput(input);
			const output: OutputDetail = {
				id: `${STAGED_OUTPUT_PREFIX}${crypto.randomUUID()}`,
				kind: input.content.kind as OutputDetail["kind"],
				title: input.title,
				status: "active",
				revision: 1,
				revisionId: null,
				updatedAt: new Date().toISOString(),
				content: input.content,
			};
			capture.writes.push({ op: "create", outputId: output.id, output });
			return { ...output, staged: STAGED_NOTE } as OutputDetail;
		},
		readableFileTitles: async (reads) => {
			const ids =
				reads && typeof reads === "object" ? Object.values(reads) : [];
			if (
				ids.some(
					(id) => typeof id === "string" && id.startsWith(STAGED_OUTPUT_PREFIX),
				)
			)
				throw new Error(
					"That file is staged in this chat and not saved yet, so an app cannot read it. The person must accept it on the review card first.",
				);
			return port.readableFileTitles(reads);
		},
		getWork: async (workItemId) => {
			const id = realId(workItemId);
			const created = staged.creating(conversationId, id);
			if (created && created.status === "pending") {
				const input = stagedWork(created).input;
				return {
					...stagedWorkSummary(created),
					description:
						typeof input.description === "string" ? input.description : null,
					staged: STAGED_NOTE,
				} as unknown as WorkItemDetail;
			}
			if (id.startsWith(STAGED_WORK_PREFIX))
				throw new Error(
					"This Work Item was staged in this chat and is not filed: it was rejected or expired.",
				);
			const detail = await port.getWork(id);
			const waiting = staged
				.pending(conversationId)
				.filter((row) => row.kind === "work" && row.target_id === id);
			return waiting.length
				? ({
						...detail,
						stagedChanges: waiting.map((row) => ({
							change: row.title,
							note: STAGED_NOTE,
						})),
					} as WorkItemDetail)
				: detail;
		},
		listWork: async (options) => {
			const real = await port.listWork(options);
			const created = staged
				.pending(conversationId)
				.filter((row) => row.kind === "work" && row.creates === 1)
				.map(stagedWorkSummary);
			return [...created, ...real];
		},
		commentOnWork: async (input) => {
			const id = realId(input.workItemId);
			if (id.startsWith(STAGED_WORK_PREFIX)) throw new Error(STAGED_CONFLICT);
			return port.commentOnWork({ ...input, workItemId: id });
		},
		acceptWork: async (input) => {
			const id = realId(input.workItemId);
			if (id.startsWith(STAGED_WORK_PREFIX)) throw new Error(STAGED_CONFLICT);
			return port.acceptWork({ ...input, workItemId: id });
		},
	};
	if (capture) {
		// Only the file writes above stage; nothing else may write from here.
		for (const name of ["createWork", "commentOnWork", "acceptWork"] as const)
			overrides[name] = () => {
				throw new Error("Only file writes stage this way");
			};
	}
	return new Proxy(port, {
		get(target, property, receiver) {
			if (typeof property === "string" && Object.hasOwn(overrides, property))
				return overrides[property as keyof typeof overrides];
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * The gate for a binding call run against the pending layer: file writes
 * pass, since they only reach the layer; everything else is refused.
 */
export const stagingCompliance: ComplianceAdapter = {
	check: async (call) =>
		call.resource === "output"
			? evaluateCall({
					riskTier: call.riskTier,
					blastRadius: call.blastRadius,
					approval: "not_required",
				})
			: {
					verdict: "deny",
					gate: "annotation_assertion",
					reason: "not_stageable",
					riskTier: call.riskTier ?? "unclassified",
					blastRadius: call.blastRadius ?? "unclassified",
				},
	record: async () => {},
};

/**
 * Staged writes change nothing real, so they leave no change record; the
 * held call's record and the accepted call's record are the trail.
 */
export const stagingAccountability: AccountabilityAdapter = {
	append: async (input) =>
		({
			schemaVersion: CHANGE_RECORD_SCHEMA_VERSION,
			...input,
			id: crypto.randomUUID(),
			recordedAt: new Date().toISOString(),
			sequence: 0,
		}) as ChangeRecord,
	list: async () => [],
	get: async () => null,
	export: async () => ({ exportedAt: new Date().toISOString(), records: [] }),
};

const KIND_LABEL: Record<string, string> = {
	document: "document",
	sheet: "sheet",
	presentation: "presentation",
	video: "video",
};

/** Text lines of a file's content, for a short before/after comparison. */
export function contentLines(content: OsOutputContent | null | undefined) {
	const lines: string[] = [];
	const visit = (value: unknown, key?: string) => {
		if (lines.length >= 400) return;
		if (typeof value === "string") {
			const text = value.trim();
			if (
				text &&
				key !== "type" &&
				key !== "kind" &&
				key !== "id" &&
				key !== "style"
			)
				lines.push(text.slice(0, 200));
		} else if (typeof value === "number" && key !== "level") {
			lines.push(String(value));
		} else if (Array.isArray(value)) value.forEach((item) => visit(item));
		else if (value && typeof value === "object")
			for (const [inner, item] of Object.entries(value))
				// A document's rich text repeats its blocks.
				if (inner !== "richText" && inner !== "attrs" && inner !== "marks")
					visit(item, inner);
	};
	visit(content);
	return lines;
}

/** At most this many added and removed lines are shown on the card. */
const DIFF_LINES = 6;

export interface StagedDiff {
	added: string[];
	removed: string[];
	moreAdded?: number;
	moreRemoved?: number;
}

export function contentDiff(
	before: OsOutputContent | null | undefined,
	after: OsOutputContent | null | undefined,
): StagedDiff {
	const count = (lines: string[]) => {
		const map = new Map<string, number>();
		for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
		return map;
	};
	const was = contentLines(before);
	const now = contentLines(after);
	const wasCount = count(was);
	const nowCount = count(now);
	const only = (lines: string[], other: Map<string, number>) => {
		const left = new Map(other);
		return lines.filter((line) => {
			const n = left.get(line) ?? 0;
			if (n > 0) {
				left.set(line, n - 1);
				return false;
			}
			return true;
		});
	};
	// Slides and sheets repeat text in derived fields: show each line once.
	const added = [...new Set(only(now, wasCount))];
	const removed = [...new Set(only(was, nowCount))];
	return {
		added: added.slice(0, DIFF_LINES),
		removed: removed.slice(0, DIFF_LINES),
		...(added.length > DIFF_LINES
			? { moreAdded: added.length - DIFF_LINES }
			: {}),
		...(removed.length > DIFF_LINES
			? { moreRemoved: removed.length - DIFF_LINES }
			: {}),
	};
}

/** One line for the card and the agent: what the staged change does. */
export function stagedTitle(
	change:
		| { kind: "output"; creates: boolean; output: OutputDetail; edits: number }
		| {
				kind: "work";
				method: StagedWorkState["method"];
				title: string;
				input: Record<string, unknown>;
		  },
): string {
	if (change.kind === "output") {
		const label = KIND_LABEL[change.output.kind] ?? "file";
		return change.creates
			? `New ${label} “${change.output.title}”`
			: `Edit ${label} “${change.output.title}”${change.edits > 1 ? ` (${change.edits} edits)` : ""}`;
	}
	if (change.method === "create") return `File Work Item “${change.title}”`;
	if (change.method === "comment")
		return `Comment on “${change.title}”: ${String(change.input.body ?? "").slice(0, 120)}`;
	return `Accept “${change.title}”: done when ${String(change.input.doneWhen ?? "").slice(0, 120)}`;
}
