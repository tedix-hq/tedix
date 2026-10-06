import { createHash } from "node:crypto";
import { buildRunId } from "./ledger-mirror";
/** Storage adapter for permanent admission. Does not activate a runtime on construction. */
import {
	RuntimeAdmission,
	type AdmissionOwner,
	type AdmissionEvidence,
	type VerificationAction,
	type TurnClaim,
	type AdmissionSnapshot,
} from "./runtime-admission";
export interface FacetAdmissionCustody {
	parentPath: unknown[];
	facetName: string;
	identityName: string;
	objectId: string;
}
export interface AcceptedRuntimeTurn {
	owner: AdmissionOwner;
	runId: string;
	sessionKey: string;
	principalId: string;
	inputHash: string;
	requestHash: string;
	generation: number;
}
function fail(message: string): never {
	throw new Error(`Runtime admission storage: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail("invalid stored evidence");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512)
		fail("invalid identity");
	return value;
}
function canonical(value: unknown): string {
	function normalize(v: unknown): unknown {
		if (v === null || typeof v === "boolean" || typeof v === "string") return v;
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (Array.isArray(v)) return v.map(normalize);
		const r = record(v);
		return Object.fromEntries(
			Object.keys(r)
				.sort()
				.map((k) => [k, normalize(r[k])]),
		);
	}
	return JSON.stringify(normalize(value));
}
async function digest(value: string): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
function parse(value: string): Record<string, unknown> {
	try {
		return record(JSON.parse(value));
	} catch {
		fail("invalid persisted JSON");
	}
}
/** SDK give-up delivery is not a child's actual final result. */
export function assertStoredAgentToolDisposition(
	row: Record<string, unknown>,
): void {
	if (
		typeof row.run_id !== "string" ||
		!row.run_id ||
		!["completed", "error", "aborted"].includes(String(row.status)) ||
		typeof row.completed_at !== "number" ||
		!Number.isFinite(row.completed_at) ||
		(row.child_still_running !== null && row.child_still_running !== 0) ||
		(row.detached !== 0 && row.detached !== 1) ||
		(row.detached === 1 && typeof row.finish_delivered_at !== "number") ||
		(row.status === "completed" && typeof row.output_json !== "string") ||
		(row.status !== "completed" && typeof row.error_message !== "string")
	)
		fail("unknown external effect receipt");
	if (typeof row.output_json === "string") {
		try {
			JSON.parse(row.output_json);
		} catch {
			fail("unknown external effect receipt");
		}
	}
}
export function assertStoredTelegramDisposition(
	key: string,
	value: unknown,
): void {
	const r = record(value),
		operation = record(r.operation),
		turn = record(r.turn);
	const input = { turn: r.turn, thread: r.thread };
	if (
		r.version !== 1 ||
		r.stage !== "completed" ||
		key !== `tedix:pi:telegram:reply:${turn.operationId}` ||
		operation.operationId !== turn.operationId ||
		operation.kind !== "telegram" ||
		typeof turn.operationId !== "string" ||
		typeof turn.sessionKey !== "string" ||
		operation.sessionKey !== turn.sessionKey ||
		JSON.stringify(operation.input) !== JSON.stringify(input) ||
		operation.requestHash !==
			createHash("sha256").update(JSON.stringify(input)).digest("hex") ||
		!Object.hasOwn(r, "claim") ||
		!Array.isArray(r.chunks) ||
		r.chunks.length === 0 ||
		r.chunks.some((c) => typeof c !== "string") ||
		!Array.isArray(r.messageIds) ||
		r.messageIds.length !== r.chunks.length ||
		r.messageIds.some((id) => typeof id !== "string" || !id.trim()) ||
		r.nextChunk !== r.chunks.length ||
		r.error !== undefined
	)
		fail("unknown external effect receipt");
}
const IDENTITIES = "runtime_admission_identities",
	EVIDENCE = "runtime_admission_evidence",
	RECEIPTS = "runtime_admission_receipts";
/** Read-only constructor guard. Existence/state is not proof of tenant activation authority. */
export function readStoredRuntimeAdmission(
	storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
	objectId: string,
): AdmissionSnapshot | null {
	text(objectId);
	if (
		storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_admission'",
			)
			.toArray().length === 0
	)
		return null;
	const row = storage.sql
		.exec<{ record: string }>("SELECT record FROM runtime_admission WHERE id=1")
		.toArray()[0];
	if (!row) fail("missing persisted admission");
	const state = parse(row.record),
		storedOwner = record(state.owner);
	if (storedOwner.objectId !== objectId)
		fail("physical object custody mismatch");
	const canonicalOwner = {
		tediId: storedOwner.tediId as string | null,
		orgId: storedOwner.orgId as string | null,
		objectId,
	};
	return new RuntimeAdmission(storage, canonicalOwner, () =>
		fail("guard cannot verify transitions"),
	).read();
}
export class RuntimeAdmissionDO {
	readonly gate: RuntimeAdmission;
	constructor(
		private readonly storage: DurableObjectStorage,
		readonly owner: AdmissionOwner,
		private readonly facetCustody?: FacetAdmissionCustody,
	) {
		this.owner = Object.freeze({ ...owner });
		this.gate = new RuntimeAdmission(storage, this.owner, (action, input) =>
			this.verify(action, input),
		);
	}
	read() {
		return this.gate.read();
	}
	private tables(): Set<string> {
		return new Set(
			this.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.toArray()
				.map((r) => r.name),
		);
	}
	private setup() {
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${IDENTITIES} (run_id TEXT PRIMARY KEY,record TEXT NOT NULL,input TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${EVIDENCE} (digest TEXT PRIMARY KEY,action TEXT NOT NULL,snapshot TEXT NOT NULL,claim TEXT)`,
		);
	}
	/** Operation claims retain their immutable parent accounting owner across continuations. */
	private accountingRunId(turnId: string): string {
		const row = this.storage.sql
			.exec<{ input: string }>(
				`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
				turnId,
			)
			.toArray()[0];
		if (!row) fail("missing accepted accounting owner");
		const original = parse(row.input);
		return original.parentRunId === undefined
			? turnId
			: text(original.parentRunId);
	}
	private receiptSnapshot(claim?: {
		turnId: string;
		requestHash: string;
		generation: number;
		submissionId: string;
	}): string {
		this.terminal(claim);
		const accountingRunId = this.accountingRunId(claim!.turnId);
		return canonical({
			owner: this.owner,
			claim,
			accepted: this.identity(claim!.turnId),
			acceptedInput: this.storage.sql
				.exec<{ input: string }>(
					`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
					claim!.turnId,
				)
				.toArray(),
			receipt: this.tables().has(RECEIPTS)
				? this.storage.sql
						.exec(
							`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
							claim!.turnId,
						)
						.toArray()
				: [],
			imageCleanup: (() => {
				const key = `workflow-image-cleanup:${accountingRunId}`,
					value = this.storage.kv.get(key);
				return value === undefined
					? null
					: this.completedImageCleanup(key, value, true);
			})(),
			accounting: [
				this.storage.kv.get(`think-accounting:${accountingRunId}`) ?? null,
				this.storage.kv.get(`pi-accounting:${accountingRunId}`) ?? null,
			],
		});
	}
	/** Retained cleanup is evidence only after both original identities and the actual final receipt agree. */
	private completedImageCleanup(
		key: string,
		value: unknown,
		receiptContext = false,
	): unknown {
		const row = record(value),
			authority = record(row.authority),
			page = record(row.page);
		const runId = text(row.runId),
			sessionKey = text(row.sessionKey),
			workflowInstanceId = text(row.workflowInstanceId);
		const cleanupId = `workflow-image-cleanup:${encodeURIComponent(runId)}`;
		const strict = (r: Record<string, unknown>, keys: string[]) => {
			if (Object.keys(r).some((k) => !keys.includes(k)))
				fail("unsettled image cleanup obligation");
		};
		strict(row, [
			"kind",
			"tediId",
			"orgId",
			"runId",
			"workflowInstanceId",
			"sessionKey",
			"refs",
			"intent",
			"authority",
			"dispatchRequested",
			"terminalIntent",
			"page",
			"completed",
		]);
		strict(authority, ["runId", "generation", "requestHash"]);
		strict(page, ["keys", "cursor", "nextCursor", "truncated", "stage"]);
		if (
			key !== `workflow-image-cleanup:${runId}` ||
			row.kind !== "workflow_image_cleanup" ||
			row.intent !== "uploaded_images" ||
			row.tediId !== this.owner.tediId ||
			row.orgId !== this.owner.orgId ||
			row.completed !== true ||
			typeof row.dispatchRequested !== "boolean" ||
			(row.terminalIntent !== undefined &&
				row.terminalIntent !== "terminal" &&
				row.terminalIntent !== "cancelled") ||
			authority.runId !== cleanupId ||
			page.stage !== "acknowledged" ||
			page.truncated !== false ||
			page.nextCursor !== null ||
			(page.cursor !== null && typeof page.cursor !== "string") ||
			!Array.isArray(row.refs) ||
			!row.refs.length ||
			row.refs.length > 4 ||
			!Array.isArray(page.keys) ||
			new Set(page.keys).size !== page.keys.length
		)
			fail("unsettled image cleanup obligation");
		const prefix = `__runtime/workflow-images/${encodeURIComponent(text(row.tediId))}/${encodeURIComponent(runId)}/`;
		const keys = new Set([prefix + "manifest.json"]);
		for (const raw of row.refs) {
			const ref = record(raw);
			strict(ref, ["key", "sha256", "mediaType", "fileName"]);
			if (
				typeof ref.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(ref.sha256) ||
				ref.key !== prefix + ref.sha256 + ".json" ||
				![
					"image/png",
					"image/jpeg",
					"image/jpg",
					"image/webp",
					"image/gif",
				].includes(String(ref.mediaType)) ||
				typeof ref.fileName !== "string" ||
				ref.fileName.length > 512
			)
				fail("unsettled image cleanup obligation");
			keys.add(ref.key as string);
		}
		if (page.keys.some((k) => typeof k !== "string" || !keys.has(k)))
			fail("unsettled image cleanup obligation");
		const sha = (v: string) => createHash("sha256").update(v).digest("hex");
		const identity = (id: string) => {
			const accepted = this.identity(id),
				saved = this.storage.sql
					.exec<{ record: string; input: string }>(
						`SELECT record,input FROM ${IDENTITIES} WHERE run_id=?`,
						id,
					)
					.toArray()[0]!;
			const { requestHash, ...fields } = accepted;
			const core = this.gate.claim(id);
			if (
				sha(saved.input) !== accepted.inputHash ||
				sha(canonical(fields)) !== requestHash ||
				!core ||
				core.requestHash !== requestHash ||
				core.generation !== accepted.generation
			)
				fail("unsettled image cleanup obligation");
			return { accepted, saved, core };
		};
		const original = identity(runId),
			cleanup = identity(cleanupId);
		if (parse(original.saved.input).kind === "workflow_image_cleanup")
			fail("nested image cleanup authority");
		const input = {
			kind: row.kind,
			tediId: row.tediId,
			orgId: row.orgId,
			runId,
			workflowInstanceId,
			sessionKey,
			refs: row.refs,
			intent: row.intent,
		};
		if (
			canonical(parse(cleanup.saved.input)) !== canonical(input) ||
			original.accepted.sessionKey !== sessionKey ||
			cleanup.accepted.sessionKey !== sessionKey ||
			cleanup.accepted.principalId !== original.accepted.principalId ||
			cleanup.accepted.generation !== original.accepted.generation ||
			cleanup.accepted.generation !== authority.generation ||
			cleanup.accepted.requestHash !== authority.requestHash ||
			cleanup.core.status !== "completed" ||
			!cleanup.core.completion
		)
			fail("unsettled image cleanup obligation");
		if (!this.tables().has(RECEIPTS) || !this.tables().has(EVIDENCE))
			fail("unsettled image cleanup obligation");
		const storedReceipt = this.storage.sql
			.exec<{ record: string }>(
				`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
				cleanupId,
			)
			.toArray()[0];
		if (!storedReceipt) fail("unsettled image cleanup obligation");
		const receipt = parse(storedReceipt.record),
			finalPage = {
				keys: page.keys,
				cursor: page.cursor,
				nextCursor: page.nextCursor,
				truncated: page.truncated,
			};
		const claim = {
			turnId: cleanupId,
			requestHash: cleanup.accepted.requestHash,
			generation: cleanup.accepted.generation,
			submissionId: cleanupId,
		};
		if (
			canonical(receipt) !==
			canonical({
				accepted: cleanup.accepted,
				sourceId: cleanupId,
				receipt: { input, receipt: finalPage },
			})
		)
			fail("unsettled image cleanup obligation");
		const evidence = this.storage.sql
			.exec<{ action: string; snapshot: string; claim: string | null }>(
				`SELECT action,snapshot,claim FROM ${EVIDENCE} WHERE digest=?`,
				cleanup.core.completion,
			)
			.toArray()[0];
		if (
			!evidence ||
			evidence.action !== "complete" ||
			evidence.claim !== canonical(claim) ||
			evidence.snapshot !== this.receiptSnapshot(claim) ||
			sha(
				canonical({
					action: "complete",
					owner: this.owner,
					snapshot: evidence.snapshot,
					claim,
				}),
			) !== cleanup.core.completion
		)
			fail("unsettled image cleanup obligation");
		return {
			key,
			row,
			// Any receipt sharing this accounting owner must survive its later completion.
			original: receiptContext
				? {
						...original,
						core: {
							turnId: original.core.turnId,
							requestHash: original.core.requestHash,
							generation: original.core.generation,
						},
					}
				: original,
			cleanup,
			receipt: storedReceipt,
			evidence,
			completion: cleanup.core.completion,
		};
	}

	private snapshot(): string {
		const names = this.tables(),
			facts: unknown[] = [];
		if (!names.has("cf_agents_state")) fail("missing stored owner");
		const stateRow = this.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			)
			.toArray()[0];
		if (!stateRow) fail("missing stored owner");
		const state = parse(stateRow.state);
		if (this.facetCustody) {
			const custody = this.facetCustody,
				metadata = record(state.aigMetadata);
			if (
				custody.objectId !== this.owner.objectId ||
				metadata.tediId !== this.owner.tediId ||
				metadata.orgId !== this.owner.orgId ||
				this.storage.kv.get("cf_agents_is_facet") !== true ||
				this.storage.kv.get("cf_agents_facet_name") !== custody.facetName ||
				canonical(this.storage.kv.get("cf_agents_parent_path")) !==
					canonical(custody.parentPath) ||
				!custody.identityName
			)
				fail("unverified facet custody");
			facts.push(["facetCustody", custody]);
		} else if (
			state.tediId !== this.owner.tediId ||
			state.orgId !== this.owner.orgId
		)
			fail("stored tenant owner mismatch");
		facts.push(["owner", this.owner]);
		for (const name of Array.from(names).sort()) {
			if (!/^[a-zA-Z0-9_]+$/.test(name)) fail("unknown storage table");
			if (name === "cf_think_scheduled_tasks") {
				const rows = this.storage.sql
					.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${name}`)
					.toArray();
				for (const row of rows)
					if (
						typeof row.task_id !== "string" ||
						(row.schedule_id !== null && typeof row.schedule_id !== "string") ||
						(row.next_run_at !== null && typeof row.next_run_at !== "number")
					)
						fail("unknown maintenance configuration");
				facts.push([name, rows]);
			} else if (name.endsWith("_tasks") || name.endsWith("_submissions")) {
				const rows = this.storage.sql
					.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${name}`)
					.toArray();
				for (const row of rows) {
					const status = row.status;
					if (typeof row.record !== "string") fail("unknown native schema");
					const r = parse(row.record),
						actual = name.endsWith("_tasks")
							? record(r.state).status
							: r.status;
					if (
						actual !== status ||
						!(name.endsWith("_tasks")
							? status === "terminal"
							: ["done", "unanswered"].includes(String(status)))
					)
						fail("nonterminal or unknown native work");
				}
				facts.push([name, rows]);
			} else if (name === "cf_agent_tool_runs") {
				const rows = this.storage.sql
					.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${name}`)
					.toArray();
				for (const row of rows) assertStoredAgentToolDisposition(row);
				facts.push([name, rows]);
			} else if (
				[
					"cf_agents_fibers",
					"cf_agents_runs",
					"cf_agents_task_runs",
					"cf_agents_workflows",
					"cf_agents_facet_runs",
				].includes(name)
			) {
				const rows = this.storage.sql
					.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${name}`)
					.toArray();
				for (const row of rows) {
					// Pinned Agents lifecycle labels are domain-specific. This only
					// qualifies stored lifecycle facts; effect receipts remain fenced below.
					const terminal =
						name === "cf_agents_runs"
							? typeof row.completed_at === "number" &&
								Number.isSafeInteger(row.completed_at) &&
								row.completed_at > 0
							: name === "cf_agents_workflows"
								? ["complete", "errored", "terminated"].includes(
										String(row.status),
									)
								: name === "cf_agents_fibers"
									? ["completed", "aborted", "error"].includes(
											String(row.status),
										)
									: name === "cf_agents_task_runs"
										? ["completed", "failed", "cancelled"].includes(
												String(row.state),
											)
										: false;
					if (!terminal) fail("nonterminal or unknown SDK work");
				}
				facts.push([name, rows]);
			}
		}
		const pairs = Array.from(this.storage.kv.list()).sort(([a], [b]) =>
			a.localeCompare(b),
		);
		for (const [key, value] of pairs) {
			if (
				["facet-pending-submission", "pi-facet-pending-submission"].includes(
					key,
				)
			)
				fail("pending native turn");
			if (
				key.startsWith("think-accounting:") ||
				key.startsWith("pi-accounting:")
			) {
				const r = record(value),
					stem = key.startsWith("think")
						? "think-accounting:"
						: "pi-accounting:";
				if (
					r.version !== 1 ||
					r.runId !== key.slice(stem.length) ||
					r.fault !== null ||
					r.receiptFault === true ||
					!Array.isArray(r.attempts)
				)
					fail("unknown accounting evidence");
				for (const raw of r.attempts) {
					const a = record(raw);
					if (
						a.phase !== "completed" ||
						a.acknowledged !== true ||
						(a.effectsStarted === true && a.effectsSealed !== true)
					)
						fail("unsettled provider or effect receipt");
				}
				facts.push([key, value]);
			} else if (key.startsWith("facet-dispatch-call:")) {
				const r = record(value);
				const identity = JSON.parse(
					key.slice("facet-dispatch-call:".length),
				) as unknown;
				if (
					canonical(identity) !== canonical([r.runId, r.toolCallId]) ||
					!["returned", "rejected"].includes(String(r.status)) ||
					typeof r.inputHash !== "string" ||
					(r.status === "returned" && typeof r.finishReason !== "string")
				)
					fail("unknown external effect receipt");
				facts.push([key, value]);
			} else if (
				key.startsWith("computer-effect:") ||
				(key.startsWith("computer-environment:") && key.includes(":execution:"))
			) {
				// These are persisted BEFORE native dispatch and contain no terminal
				// receipt or original run identity. Lease presence cannot prove ACK.
				fail("unknown external effect receipt");
			} else if (key.startsWith("tedix:pi:telegram:reply:")) {
				assertStoredTelegramDisposition(key, value);
				const r = record(value),
					operation = record(r.operation);
				if (r.claim !== null) {
					const claim = record(r.claim),
						runId = buildRunId(
							text(this.owner.tediId),
							text(operation.operationId),
							"chat",
						);
					const accepted = this.identity(runId),
						core = this.gate.claim(runId);
					const row = this.storage.sql
						.exec<{ input: string }>(
							`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
							runId,
						)
						.toArray()[0];
					const { requestHash, ...fields } = accepted;
					if (
						!core ||
						core.requestHash !== accepted.requestHash ||
						core.generation !== accepted.generation ||
						claim.generation !== accepted.generation ||
						accepted.principalId !== this.owner.tediId ||
						accepted.sessionKey !== operation.sessionKey ||
						!row ||
						row.input !== canonical(operation) ||
						createHash("sha256").update(row.input).digest("hex") !==
							accepted.inputHash ||
						createHash("sha256").update(canonical(fields)).digest("hex") !==
							requestHash ||
						!names.has(RECEIPTS)
					)
						fail("unknown external effect receipt");
					const terminalRow = this.storage.sql
						.exec<{ record: string }>(
							`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
							runId,
						)
						.toArray()[0];
					const terminal = terminalRow
						? parse(terminalRow.record)
						: fail("unknown external effect receipt");
					const completion = record(terminal.receipt),
						settlement = record(
							this.storage.kv.get(`runtime-admission-settlement:${runId}`),
						);
					const ackHash = createHash("sha256")
						.update(
							JSON.stringify({
								operationId: operation.operationId,
								messageIds: r.messageIds,
								nextChunk: r.nextChunk,
							}),
						)
						.digest("hex");
					if (
						canonical(terminal.accepted) !== canonical(accepted) ||
						terminal.sourceId !== operation.operationId ||
						completion.terminal !== "completed" ||
						completion.receiptHash !== ackHash ||
						settlement.sessionKey !== accepted.sessionKey ||
						!Object.hasOwn(settlement, "assistant")
					)
						fail("unknown external effect receipt");
					this.terminal({
						turnId: runId,
						requestHash: accepted.requestHash,
						generation: accepted.generation,
						submissionId: text(terminal.sourceId),
					});
					facts.push(
						["telegram-terminal", terminal],
						[
							"telegram-settlement",
							this.storage.kv.get(`runtime-admission-settlement:${runId}`),
						],
					);
				}
				// A null claim is explicitly pre-admission history. Its known physical
				// owner, immutable input and actual send IDs prove delivery only; no
				// accepted runtime claim is invented by this baseline verifier.
				facts.push([key, value]);
			} else if (
				key.startsWith("computer-continuation:") ||
				key.startsWith("computer-continuation-segment:") ||
				key.startsWith("computer-exec-wake:")
			) {
				// Cached segments precede canonical commit, and terminal process reads
				// precede owning-model collection. Neither is a terminal delivery ACK.
				let runId: string;
				if (key.startsWith("computer-continuation:")) {
					runId = key.slice("computer-continuation:".length);
					const r = record(value),
						identity = JSON.parse(String(r.identity));
					if (
						!Array.isArray(identity) ||
						identity[0] !== runId ||
						typeof identity[1] !== "string" ||
						typeof identity[2] !== "string" ||
						!Number.isSafeInteger(r.activeSegment)
					)
						fail("unknown external effect receipt");
				} else if (key.startsWith("computer-continuation-segment:")) {
					const identity = JSON.parse(
						key.slice("computer-continuation-segment:".length),
					);
					if (
						!Array.isArray(identity) ||
						typeof identity[0] !== "string" ||
						!Number.isSafeInteger(identity[1])
					)
						fail("unknown external effect receipt");
					runId = identity[0];
				} else {
					const r = record(value),
						env = record(r.environment),
						receipt = record(r.terminalReceipt);
					if (
						key !== `computer-exec-wake:${r.executionId}` ||
						typeof r.launchedByRunId !== "string" ||
						r.collectedByRunId !== r.launchedByRunId ||
						typeof r.workItemId !== "string" ||
						typeof env.leaseId !== "string" ||
						receipt.terminal !== true ||
						receipt.found === false ||
						receipt.ok === false
					)
						fail("unknown external effect receipt");
					runId = r.launchedByRunId;
				}
				if (!names.has(RECEIPTS)) fail("unknown external effect receipt");
				const terminal = this.storage.sql
					.exec<{ record: string }>(
						`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
						runId,
					)
					.toArray()[0];
				if (!terminal) fail("unknown external effect receipt");
				const receipt = parse(terminal.record),
					accepted = this.identity(runId);
				const inputRow = this.storage.sql
					.exec<{ input: string }>(
						`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
						runId,
					)
					.toArray()[0];
				const { requestHash, ...fields } = accepted;
				if (
					!inputRow ||
					createHash("sha256").update(inputRow.input).digest("hex") !==
						accepted.inputHash ||
					createHash("sha256").update(canonical(fields)).digest("hex") !==
						requestHash
				)
					fail("unknown external effect receipt");
				const original = parse(inputRow.input),
					run = record(this.storage.kv.get(`computer-continuation:${runId}`));
				const identity = JSON.parse(String(run.identity));
				if (
					!Array.isArray(identity) ||
					identity[0] !== runId ||
					identity[1] !== original.workItemId ||
					identity[2] !== original.homeRunId ||
					identity[3] !== accepted.sessionKey ||
					!Number.isSafeInteger(run.activeSegment) ||
					Number(run.activeSegment) < 0
				)
					fail("unknown external effect receipt");
				const current = record(
					this.storage.kv.get(
						`computer-continuation-segment:${JSON.stringify([runId, run.activeSegment])}`,
					),
				);
				if (
					typeof current.text !== "string" ||
					typeof current.stopReason !== "string" ||
					!Array.isArray(current.toolCalls) ||
					current.failureReason !== undefined ||
					(current.pendingComputerExecutions !== undefined &&
						(!Array.isArray(current.pendingComputerExecutions) ||
							current.pendingComputerExecutions.length))
				)
					fail("unknown external effect receipt");
				if (
					canonical(receipt.accepted) !== canonical(accepted) ||
					typeof receipt.sourceId !== "string" ||
					!Object.hasOwn(receipt, "receipt")
				)
					fail("unknown external effect receipt");
				this.terminal({
					turnId: runId,
					requestHash: accepted.requestHash,
					generation: accepted.generation,
					submissionId: receipt.sourceId,
				});
				facts.push([key, value], ["computer-terminal", receipt]);
			} else if (key.startsWith("workflow-image-cleanup:"))
				facts.push(this.completedImageCleanup(key, value));
			else if (key.startsWith("computer-acquisition:")) {
				const r = record(value);
				if (r.ownerRunId !== null && typeof r.ownerRunId !== "string")
					fail("unknown acquisition owner");
				if (typeof r.ownerRunId === "string") {
					if (
						r.callId !== key.slice("computer-acquisition:".length) ||
						r.confirmed === undefined ||
						typeof record(r.confirmed).leaseId !== "string"
					)
						fail("unsettled owned computer acquisition");
					facts.push([key, value]);
				}
			} else if (
				key.startsWith("ledger-outbox:") ||
				key.startsWith("ledger-delivery-blocked:")
			)
				fail("unsettled ledger delivery");
			else if (key.startsWith("wfctx:")) fail("unresolved workflow dispatch");
			else if (
				key.startsWith("__cf_messenger_recovery:") ||
				key.startsWith("cf:chat-recovery:incident:")
			) {
				const r = record(value),
					status = key.startsWith("__cf") ? r.stage : r.status;
				if (
					!(key.startsWith("__cf")
						? status === "completed"
						: ["completed", "skipped", "exhausted", "failed"].includes(
								String(status),
							))
				)
					fail("unknown recovery effect");
				facts.push([key, value]);
			}
		}
		return canonical(facts);
	}
	/** Evidence is content addressed, then reread inside the admission transaction. No boolean trust shortcut. */
	async prepareEvidence(
		action: VerificationAction,
		claim?: {
			turnId: string;
			requestHash: string;
			generation: number;
			submissionId: string;
		},
	): Promise<string> {
		if (action === "complete") {
			if (!claim) fail("missing original terminal ownership");
			const verified = await this.lookupAcceptedTurn(claim.turnId);
			if (
				canonical(this.identity(claim.turnId)) !== canonical(verified) ||
				verified.requestHash !== claim.requestHash ||
				verified.generation !== claim.generation
			)
				fail("original receipt identity changed");
		}
		const snapshot =
			action === "complete" ? this.receiptSnapshot(claim) : this.snapshot();
		const hash = await digest(
			canonical({ action, owner: this.owner, snapshot, claim: claim ?? null }),
		);
		this.storage.transactionSync(() => {
			if (
				(action === "complete"
					? this.receiptSnapshot(claim)
					: this.snapshot()) !== snapshot
			)
				fail("baseline changed while hashing");
			if (action === "complete") this.terminal(claim);
			this.setup();
			const existing = this.storage.sql
				.exec<{ snapshot: string; action: string; claim: string | null }>(
					`SELECT snapshot,action,claim FROM ${EVIDENCE} WHERE digest=?`,
					hash,
				)
				.toArray()[0];
			const claimText = claim ? canonical(claim) : null;
			if (
				existing &&
				(existing.snapshot !== snapshot ||
					existing.action !== action ||
					existing.claim !== claimText)
			)
				fail("evidence identity conflict");
			if (!existing)
				this.storage.sql.exec(
					`INSERT INTO ${EVIDENCE} VALUES (?,?,?,?)`,
					hash,
					action,
					snapshot,
					claimText,
				);
		});
		return hash;
	}
	private terminal(claim?: {
		turnId: string;
		requestHash: string;
		generation: number;
		submissionId: string;
	}) {
		if (!claim) fail("missing original terminal ownership");
		const accountingRunId = this.accountingRunId(claim.turnId);
		for (const stem of ["think-accounting:", "pi-accounting:"]) {
			const value = this.storage.kv.get(stem + accountingRunId);
			if (value === undefined) continue;
			const journal = record(value);
			if (
				journal.runId !== accountingRunId ||
				journal.version !== 1 ||
				journal.fault !== null ||
				journal.receiptFault === true ||
				!Array.isArray(journal.attempts) ||
				journal.attempts.some((raw) => {
					const a = record(raw);
					return (
						a.phase !== "completed" ||
						a.acknowledged !== true ||
						(a.effectsStarted === true && a.effectsSealed !== true)
					);
				})
			)
				fail("original run accounting unsettled");
		}
		// Native KV permits one iterator; consume it before nested receipt verification.
		const entries = Array.from(this.storage.kv.list());
		for (const [key, value] of entries) {
			if (key === `workflow-image-cleanup:${accountingRunId}`)
				this.completedImageCleanup(key, value);
			if (key.startsWith("facet-dispatch-call:")) {
				const r = record(value);
				if (
					r.runId === accountingRunId &&
					!["returned", "rejected"].includes(String(r.status))
				)
					fail("original claim external effect unsettled");
			}
			if (
				key.startsWith("ledger-outbox:") ||
				key.startsWith("ledger-delivery-blocked:")
			) {
				const r = record(value);
				const event = r.event === undefined ? r : record(r.event);
				if (event.runId === accountingRunId)
					fail("original claim ledger delivery unsettled");
			}
		}
		const accepted = this.identity(claim.turnId),
			core = this.gate.claim(claim.turnId);
		if (
			accepted.requestHash !== claim.requestHash ||
			accepted.generation !== claim.generation ||
			!core ||
			core.requestHash !== claim.requestHash ||
			core.generation !== claim.generation
		)
			fail("terminal ownership conflict");
		if (this.tables().has(RECEIPTS)) {
			const stored = this.storage.sql
				.exec<{ record: string }>(
					`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
					claim.turnId,
				)
				.toArray()[0];
			if (stored) {
				const receipt = parse(stored.record);
				if (
					canonical(receipt.accepted) !== canonical(accepted) ||
					receipt.sourceId !== claim.submissionId
				)
					fail("terminal custody conflict");
				return;
			}
		}
		const acceptedInput = this.storage.sql
			.exec<{ input: string }>(
				`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
				claim.turnId,
			)
			.toArray()[0];
		const original = acceptedInput
			? parse(acceptedInput.input)
			: fail("missing accepted native input");
		if (
			original.durableSubmissionId !== claim.submissionId &&
			original.submissionId !== claim.submissionId
		)
			fail("native submission was not accepted under original claim");
		if (!this.tables().has("pi_submissions"))
			fail("missing native terminal source");
		const rows = this.storage.sql
			.exec<{ status: string; record: string }>(
				"SELECT status,record FROM pi_submissions WHERE request_id=?",
				JSON.stringify(claim.submissionId),
			)
			.toArray();
		if (rows.length !== 1 || rows[0]!.status !== "done")
			fail("native terminal not verified");
		const r = parse(rows[0]!.record);
		if (r.requestId !== claim.submissionId || r.status !== "done")
			fail("native terminal identity changed");
		const result = this.storage.kv.get(
			`facet-submission-result:${claim.submissionId}`,
		);
		if (result === undefined) fail("missing owned facet result");
		const value = record(result),
			turn = record(value.result);
		if (
			typeof turn.turnCount !== "number" ||
			typeof turn.assistantText !== "string"
		)
			fail("malformed owned facet result");
	}
	private verify(
		action: VerificationAction,
		input: Readonly<Record<string, unknown>>,
	): AdmissionEvidence {
		if (!this.tables().has(EVIDENCE) || typeof input.evidence !== "string")
			fail("missing explicit baseline evidence");
		const e = this.storage.sql
			.exec<{ snapshot: string; action: string; claim: string | null }>(
				`SELECT snapshot,action,claim FROM ${EVIDENCE} WHERE digest=?`,
				input.evidence,
			)
			.toArray()[0];
		if (!e || e.action !== action) fail("stale baseline evidence");
		let original: AdmissionEvidence["claim"];
		if (action === "complete") {
			const c = e.claim ? parse(e.claim) : fail("missing terminal evidence");
			const claim = {
				turnId: text(c.turnId),
				requestHash: text(c.requestHash),
				generation: c.generation as number,
				submissionId: text(c.submissionId),
			};
			if (
				claim.turnId !== input.turnId ||
				claim.requestHash !== input.requestHash ||
				claim.generation !== input.generation
			)
				fail("original receipt identity changed");
			this.terminal(claim);
			original = {
				turnId: claim.turnId,
				requestHash: claim.requestHash,
				generation: claim.generation,
			};
		}
		if (
			e.snapshot !==
			(action === "complete"
				? this.receiptSnapshot(
						e.claim
							? (parse(e.claim) as unknown as {
									turnId: string;
									requestHash: string;
									generation: number;
									submissionId: string;
								})
							: undefined,
					)
				: this.snapshot())
		)
			fail("stale baseline evidence");
		return {
			owner: this.owner,
			digest: input.evidence,
			complete: true,
			unknown: 0,
			nonterminal: 0,
			...(original ? { claim: original, terminal: true } : {}),
		};
	}
	private identity(runId: string): AcceptedRuntimeTurn {
		text(runId);
		if (!this.tables().has(IDENTITIES)) fail("missing accepted identity");
		const row = this.storage.sql
			.exec<{ record: string }>(
				`SELECT record FROM ${IDENTITIES} WHERE run_id=?`,
				runId,
			)
			.toArray()[0];
		if (!row) fail("missing accepted identity");
		const r = parse(row.record);
		if (canonical(r.owner) !== canonical(this.owner) || r.runId !== runId)
			fail("accepted owner changed");
		text(r.sessionKey);
		text(r.principalId);
		text(r.inputHash);
		text(r.requestHash);
		if (
			typeof r.generation !== "number" ||
			!Number.isSafeInteger(r.generation) ||
			r.generation < 1
		)
			fail("invalid accepted generation");
		return r as unknown as AcceptedRuntimeTurn;
	}
	/** Parent supplies its verified principal; never take principalId from an untrusted turn payload. */
	async beginAcceptedTurn(input: {
		runId: string;
		sessionKey: string;
		principalId: string;
		input: unknown;
		expectedGeneration: number;
	}): Promise<{
		newlyAccepted: boolean;
		claim: TurnClaim;
		accepted: AcceptedRuntimeTurn;
	}> {
		const fullInput = canonical(input.input),
			inputHash = await digest(fullInput);
		const fields = {
			owner: this.owner,
			runId: text(input.runId),
			sessionKey: text(input.sessionKey),
			principalId: text(input.principalId),
			inputHash,
			generation: input.expectedGeneration,
		};
		const accepted = {
			...fields,
			requestHash: await digest(canonical(fields)),
		};
		return this.storage.transactionSync(() => {
			this.setup();
			const previous = this.storage.sql
				.exec<{ record: string; input: string }>(
					`SELECT record,input FROM ${IDENTITIES} WHERE run_id=?`,
					accepted.runId,
				)
				.toArray()[0];
			if (
				previous &&
				(previous.record !== canonical(accepted) ||
					previous.input !== fullInput)
			)
				fail("accepted input identity changed");
			const result = this.gate.beginTurn({
				turnId: accepted.runId,
				requestHash: accepted.requestHash,
				expectedGeneration: accepted.generation,
			});
			if (!previous)
				this.storage.sql.exec(
					`INSERT INTO ${IDENTITIES} VALUES (?,?,?)`,
					accepted.runId,
					canonical(accepted),
					fullInput,
				);
			return { ...result, accepted };
		});
	}
	async lookupAcceptedTurn(runId: string): Promise<AcceptedRuntimeTurn> {
		const a = this.identity(runId),
			{ requestHash, ...fields } = a;
		if ((await digest(canonical(fields))) !== requestHash)
			fail("accepted identity hash mismatch");
		const row = this.storage.sql
			.exec<{ input: string }>(
				`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
				runId,
			)
			.toArray()[0];
		if (!row || (await digest(row.input)) !== a.inputHash)
			fail("accepted input hash mismatch");
		const c = this.gate.claim(runId);
		if (
			!c ||
			c.requestHash !== a.requestHash ||
			c.generation !== a.generation ||
			canonical(this.identity(runId)) !== canonical(a)
		)
			fail("accepted claim changed");
		return a;
	}
	async assertOriginalClaim(input: {
		runId: string;
		sessionKey?: string;
		principalId?: string;
		inputHash?: string;
		input?: unknown;
	}): Promise<AcceptedRuntimeTurn> {
		const a = await this.lookupAcceptedTurn(input.runId);
		if (
			(input.sessionKey !== undefined && input.sessionKey !== a.sessionKey) ||
			(input.principalId !== undefined &&
				input.principalId !== a.principalId) ||
			(input.inputHash !== undefined && input.inputHash !== a.inputHash) ||
			(Object.hasOwn(input, "input") &&
				(await digest(canonical(input.input))) !== a.inputHash)
		)
			fail("original accepted identity changed");
		return a;
	}
	/** Trusted parent calls only after owned answer, actual accounting, outbox and ledger settlement. */
	async recordTerminalReceipt(
		runId: string,
		input: { sourceId: string; receipt: unknown },
	): Promise<AcceptedRuntimeTurn> {
		const accepted = await this.lookupAcceptedTurn(runId),
			payload = canonical({
				accepted,
				sourceId: text(input.sourceId),
				receipt: input.receipt,
			});
		this.storage.transactionSync(() => {
			if (canonical(this.identity(runId)) !== canonical(accepted))
				fail("original accepted identity changed");
			this.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS ${RECEIPTS} (run_id TEXT PRIMARY KEY,record TEXT NOT NULL)`,
			);
			const prior = this.storage.sql
				.exec<{ record: string }>(
					`SELECT record FROM ${RECEIPTS} WHERE run_id=?`,
					runId,
				)
				.toArray()[0];
			if (prior && prior.record !== payload) fail("terminal receipt conflict");
			if (!prior)
				this.storage.sql.exec(
					`INSERT INTO ${RECEIPTS} VALUES (?,?)`,
					runId,
					payload,
				);
		});
		return accepted;
	}
	/** Final local wire check: no awaits, initialization, or authority inferred from metadata. */
	assertAcceptedTurnSync(input: {
		runId: string;
		expected?: AcceptedRuntimeTurn;
	}): AcceptedRuntimeTurn {
		const a = this.identity(input.runId),
			{ requestHash, ...fields } = a;
		const row = this.storage.sql
			.exec<{ input: string }>(
				`SELECT input FROM ${IDENTITIES} WHERE run_id=?`,
				input.runId,
			)
			.toArray()[0];
		if (
			createHash("sha256").update(canonical(fields)).digest("hex") !==
			requestHash
		)
			fail("accepted identity hash mismatch");
		if (
			!row ||
			createHash("sha256").update(row.input).digest("hex") !== a.inputHash
		)
			fail("accepted input hash mismatch");
		if (input.expected && canonical(a) !== canonical(input.expected))
			fail("accepted identity changed");
		this.gate.assertTurn({
			turnId: a.runId,
			requestHash: a.requestHash,
			generation: a.generation,
		});
		return a;
	}
	async assertAcceptedTurn(input: {
		runId: string;
		sessionKey?: string;
		principalId?: string;
		inputHash?: string;
		input?: unknown;
	}): Promise<AcceptedRuntimeTurn> {
		const a = await this.lookupAcceptedTurn(input.runId);
		if (
			(input.sessionKey !== undefined && input.sessionKey !== a.sessionKey) ||
			(input.principalId !== undefined &&
				input.principalId !== a.principalId) ||
			(input.inputHash !== undefined && input.inputHash !== a.inputHash) ||
			(Object.hasOwn(input, "input") &&
				(await digest(canonical(input.input))) !== a.inputHash)
		)
			fail("accepted identity changed");
		this.gate.assertTurn({
			turnId: a.runId,
			requestHash: a.requestHash,
			generation: a.generation,
		});
		return a;
	}
}
