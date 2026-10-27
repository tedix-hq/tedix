import { createTediLogger, contentFreeTediException } from "../../../log";
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import type { RecordArtifactInput } from "@tedix/api-contract/schemas/cognitive-runtime";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { type WorkstationRuntimeBody } from "../../../workstation/computer-body";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { toJsonRecord } from "@tedix/db/utils/json";
import { createDbClient } from "@tedix/db/client";
import {
	getWorkstationLeaseBundle,
	upsertWorkstationLeaseBundle,
} from "../../../workstation/persistence";
import { r2PrefixForTedi, uniqueStrings } from "./shared";
import {
	ACTIVE_WORKSTATION_PROFILE_ID,
	WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF,
	MAX_REVIEWER_OPENABLE_LOG_BYTES,
} from "./constants";
import {
	type WorkstationProcessEvidence,
	type WorkstationJobStatus,
} from "./types";
import {
	type JobObservationDiagnostics,
	buildWorkstationProcessEvidence,
} from "./process-runtime";

const log = createTediLogger("tedi.workstation.receipt");

export function workstationProcessArtifactRefs(
	c: Context<AppEnv>,
	processId: string,
) {
	const baseKey = `${r2PrefixForTedi(c)}/workstations/${ACTIVE_WORKSTATION_PROFILE_ID}/processes/${processId}/terminal`;
	const evidenceKey = `${baseKey}/evidence.json`;
	const stdoutKey = `${baseKey}/stdout.log`;
	const stderrKey = `${baseKey}/stderr.log`;
	const refForKey = (key: string) =>
		`r2://${WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF}/${key}`;
	return {
		evidence: { key: evidenceKey, ref: refForKey(evidenceKey) },
		stdout: { key: stdoutKey, ref: refForKey(stdoutKey) },
		stderr: { key: stderrKey, ref: refForKey(stderrKey) },
		refs: [refForKey(evidenceKey), refForKey(stdoutKey), refForKey(stderrKey)],
	};
}

export async function readPersistedProcessEvidence(
	c: Context<AppEnv>,
	processId: string,
	diagnostics?: JobObservationDiagnostics,
): Promise<WorkstationProcessEvidence | null> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.get !== "function") {
		if (diagnostics) diagnostics.retainedEvidence = "binding_unavailable";
		return null;
	}
	const artifacts = workstationProcessArtifactRefs(c, processId);
	if (diagnostics) diagnostics.retainedEvidence = "pending";
	try {
		const obj = await c.env.TEDI_STORAGE.get(artifacts.evidence.key);
		if (!obj) {
			if (diagnostics) diagnostics.retainedEvidence = "absent";
			return null;
		}
		const text = await obj.text();
		let parsed: WorkstationProcessEvidence;
		try {
			parsed = JSON.parse(text) as WorkstationProcessEvidence;
		} catch {
			if (diagnostics) diagnostics.retainedEvidence = "invalid";
			return null;
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			typeof parsed.processId !== "string" ||
			parsed.processId !== processId ||
			typeof parsed.workstationId !== "string" ||
			!parsed.workstationId ||
			!Array.isArray(parsed.artifactRefs) ||
			(!parsed.terminal && !parsed.canceled && !parsed.timedOut)
		) {
			if (diagnostics) diagnostics.retainedEvidence = "invalid";
			return null;
		}
		if (diagnostics) diagnostics.retainedEvidence = "valid";
		return parsed;
	} catch {
		if (diagnostics) diagnostics.retainedEvidence = "read_failed";
		return null;
	}
}

export function sanitizeArtifactIdPart(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._:-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96) || "unknown"
	);
}

export function compactArtifactMetadata(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null || value === "") continue;
		out[key] = value;
	}
	return out;
}

export function workstationSourceArtifactRefs(
	refs: readonly string[],
): string[] {
	return Array.from(
		new Set(
			refs.map((ref) => ref.trim()).filter((ref) => ref.startsWith("r2://")),
		),
	);
}

export function resolveWorkstationArtifactScopeRunId(input: {
	kernelRunId?: string | null;
	workItemId?: string | null;
}): string | null {
	const kernelRunId = input.kernelRunId?.trim();
	if (kernelRunId) return kernelRunId;
	const workItemId = input.workItemId?.trim();
	return workItemId ? `work-item:${workItemId}` : null;
}

export function workstationArtifactDescriptor(
	ref: string,
	index: number,
): { idPart: string; mimeType: string; name: string; refType: string } {
	const fileName = ref.split(/[/?#]/).filter(Boolean).at(-1) ?? `log-${index}`;
	if (fileName === "evidence.json") {
		return {
			idPart: "evidence",
			mimeType: "application/json",
			name: "evidence.json",
			refType: "evidence",
		};
	}
	if (fileName === "stdout.log") {
		return {
			idPart: "stdout",
			mimeType: "text/plain; charset=utf-8",
			name: "stdout.log",
			refType: "stdout",
		};
	}
	if (fileName === "stderr.log") {
		return {
			idPart: "stderr",
			mimeType: "text/plain; charset=utf-8",
			name: "stderr.log",
			refType: "stderr",
		};
	}
	const idPart = sanitizeArtifactIdPart(fileName || `log-${index}`);
	return {
		idPart,
		mimeType: "application/octet-stream",
		name: fileName || `log-${index}`,
		refType: "other",
	};
}

export async function recordArtifactRow(
	c: Context<AppEnv>,
	input: RecordArtifactInput,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	const headers: Record<string, string> = {
		"X-Service-Binding": "true",
		"X-Tedix-Caller": "tedi-workstation-route",
		"X-Tedix-Tedi-Scopes": "tedis:write",
		"X-Tedix-Tedi-Id": tediConfig.id,
	};
	if (tediConfig.organizationId) {
		headers["X-Tedix-Org-Id"] = tediConfig.organizationId;
	}
	if (!c.env.API_SERVICE) throw new Error("api_service_binding_unavailable");
	await callRpc("cognitiveRuntime/recordArtifact", input, {
		apiUrl: "https://api",
		fetch: serviceBindingFetch(c.env.API_SERVICE),
		headers,
	});
}

export async function recordWorkstationProcessArtifactRows(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	evidence: WorkstationProcessEvidence,
): Promise<NonNullable<WorkstationJobStatus["artifactRowPersistence"]>> {
	const refs = workstationSourceArtifactRefs(evidence.artifactRefs);
	if (refs.length === 0)
		return { reason: "no_artifact_refs", status: "skipped" };
	const runId = resolveWorkstationArtifactScopeRunId(evidence);
	if (!runId) {
		return {
			reason: "artifact_scope_unavailable",
			status: "skipped",
		};
	}
	if (!c.env.API_SERVICE) {
		return { reason: "api_service_binding_unavailable", status: "skipped" };
	}
	const conversationId = job.context?.conversationId?.trim();
	if (
		!conversationId ||
		!job.context?.kernelRunId ||
		job.context.kernelRunId !== runId ||
		evidence.kernelRunId !== runId ||
		evidence.conversationId !== conversationId ||
		job.context.participantTediId !== c.get("tediConfig").id
	) {
		return { reason: "conversation_provenance_unavailable", status: "skipped" };
	}

	const tediConfig = c.get("tediConfig");
	const safeProcessId = sanitizeArtifactIdPart(evidence.processId);
	const processArtifacts = workstationProcessArtifactRefs(
		c,
		evidence.processId,
	);
	const keyForRef = new Map([
		[processArtifacts.evidence.ref, processArtifacts.evidence.key],
		[processArtifacts.stdout.ref, processArtifacts.stdout.key],
		[processArtifacts.stderr.ref, processArtifacts.stderr.key],
	]);
	const existingPersistence = job.artifactRowPersistence;
	const trustedExistingIds = new Set(
		existingPersistence &&
			(existingPersistence.status === "persisted" ||
				existingPersistence.status === "failed") &&
			Array.isArray(existingPersistence.artifactIds)
			? existingPersistence.artifactIds
			: [],
	);
	const results = await Promise.all(
		refs.map(async (ref, index) => {
			const descriptor = workstationArtifactDescriptor(ref, index);
			const artifactId = `${runId}:artifact:workstation_process:${safeProcessId}:${descriptor.idPart}`;
			if (trustedExistingIds.has(artifactId)) return { artifactId };
			const metadata = compactArtifactMetadata({
				subKind: "workstation_process",
				producer: "workstation-adapter",
				source: "workstation_process",
				processId: evidence.processId,
				refType: descriptor.refType,
				eventType: evidence.eventType,
				workItemId: evidence.workItemId,
				kernelRunId: evidence.kernelRunId,
				traceId: evidence.traceId,
				traceBundleId: job.context?.traceBundleId,
				workstationId: evidence.workstationId,
				leaseId: evidence.leaseId,
				sessionId: evidence.sessionId,
				participantId: evidence.participantId,
				participantTediId: evidence.participantTediId,
				profileId: evidence.profileId,
				exitCode: evidence.exitCode,
				canceled: evidence.canceled,
				timedOut: evidence.timedOut,
				ref,
			});
			const inlineContent =
				descriptor.refType === "evidence"
					? `${JSON.stringify({ ...evidence, artifactRefs: refs }, null, 2)}\n`
					: (() => {
							const key = keyForRef.get(ref);
							return key && c.env.TEDI_STORAGE
								? readBoundedR2Text(
										c.env.TEDI_STORAGE,
										key,
										MAX_REVIEWER_OPENABLE_LOG_BYTES,
									)
								: Promise.resolve("");
						})();
			try {
				const content = await inlineContent;
				await recordArtifactRow(c, {
					id: artifactId,
					tediId: tediConfig.id,
					conversationId,
					runId,
					kind: "log",
					name: `workstation_process/${safeProcessId}/${descriptor.name}`,
					mimeType: descriptor.mimeType,
					// Publish the receipt body through the canonical artifact service so
					// an independent reviewer can open artifact://<id>. Keep stdout and
					// stderr as immutable R2-backed rows; the receipt links both logs.
					...(content
						? {
								content,
								contentEncoding: "utf8" as const,
							}
						: { uri: ref }),
					metadata,
				});
				return { artifactId };
			} catch (error) {
				return { error: errorMessage(error) };
			}
		}),
	);
	const artifactIds = results.flatMap((result) =>
		result.artifactId ? [result.artifactId] : [],
	);
	const recorded = artifactIds.length;
	const firstError = results.find((result) => result.error)?.error;
	return {
		artifactIds,
		recorded,
		skipped: refs.length - recorded,
		status: firstError ? "failed" : "persisted",
		...(firstError ? { error: firstError } : {}),
	};
}

export async function readBoundedR2Text(
	bucket: R2Bucket,
	key: string,
	maxBytes: number,
): Promise<string> {
	try {
		const obj = await bucket.get(key);
		if (!obj) return "";
		const size = obj.size ?? 0;
		const offset = size > maxBytes ? size - maxBytes : 0;
		const slice =
			offset > 0
				? await bucket.get(key, { range: { offset, length: maxBytes } })
				: obj;
		if (!slice) return "";
		return await slice.text();
	} catch {
		return "";
	}
}

export async function addWorkItemProcessComment(
	c: Context<AppEnv>,
	evidence: WorkstationProcessEvidence,
	outputPreview: { stdoutTail: string; stderrTail: string } | null,
): Promise<void> {
	const workItemId = evidence.workItemId?.trim();
	if (
		!workItemId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			workItemId,
		)
	)
		return;
	if (!evidence.terminal && !evidence.canceled && !evidence.timedOut) return;
	if (!c.env.API_SERVICE) return;

	const tediConfig = c.get("tediConfig");
	const eventLabel = evidence.canceled
		? "canceled"
		: evidence.timedOut
			? "timed_out"
			: evidence.exitCode === 0
				? "completed"
				: "failed";

	const artifactCount = evidence.artifactRefs.length;
	const lines: string[] = [
		`Command: ${(evidence.command ?? "").slice(0, 200)}`,
		`Exit code: ${evidence.exitCode ?? "—"} (${eventLabel})`,
	];
	if (evidence.startedAt && evidence.endedAt) {
		const ms =
			new Date(evidence.endedAt).getTime() -
			new Date(evidence.startedAt).getTime();
		lines.push(`Duration: ${ms}ms`);
	}

	const stdoutPreview = outputPreview?.stdoutTail?.slice(-800) ?? "";
	const stderrPreview = outputPreview?.stderrTail?.slice(-400) ?? "";
	if (stdoutPreview) {
		lines.push(`\nstdout (tail):\n${stdoutPreview}`);
	}
	if (stderrPreview) {
		lines.push(`\nstderr (tail):\n${stderrPreview}`);
	}

	lines.push(`\nArtifacts: ${artifactCount}`);
	for (const ref of evidence.artifactRefs.slice(0, 3)) {
		lines.push(`  ${ref.slice(0, 300)}`);
	}
	if (artifactCount > 3)
		lines.push(`  (${artifactCount - 3} more refs in metadata.artifactRefs)`);

	const commentBody = lines.join("\n").slice(0, 5000);
	const metadata: Record<string, unknown> = {
		processId: evidence.processId,
		eventType: evidence.eventType,
		exitCode: evidence.exitCode,
		artifactCount,
		kernelRunId: evidence.kernelRunId,
		leaseId: evidence.leaseId,
		participantId: evidence.participantId,
		participantTediId: evidence.participantTediId,
		sessionId: evidence.sessionId,
		workstationId: evidence.workstationId,
	};
	if (artifactCount > 0)
		metadata.artifactRefs = evidence.artifactRefs.slice(0, 5);

	const headers: Record<string, string> = {
		"X-Service-Binding": "true",
		"X-Tedix-Caller": "tedi-workstation-route",
		"X-Tedix-Tedi-Id": tediConfig.id,
	};
	if (tediConfig.organizationId)
		headers["X-Tedix-Org-Id"] = tediConfig.organizationId;

	try {
		await callRpc(
			"workItems/addComment",
			{
				id: workItemId,
				authorType: "tedi",
				authorId: tediConfig.id,
				body: commentBody,
				eventType: `workstation.process.${eventLabel}`,
				metadata,
			},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(c.env.API_SERVICE),
				headers,
			},
		);
	} catch (error) {
		console.warn(
			"[workstation] addWorkItemProcessComment error:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function stageWorkstationSpool(
	body: WorkstationRuntimeBody,
	bucket: R2Bucket,
	path: string,
	key: string,
): Promise<void> {
	const file = await body.readFile(path, { encoding: "none" });
	const bytes =
		file.content instanceof Uint8Array
			? file.content
			: new TextEncoder().encode(file.content);
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
	});
}

export async function writeWorkstationProcessArtifacts(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	body: Record<string, unknown> | null,
): Promise<{
	artifactRefs: string[];
	evidence: WorkstationProcessEvidence;
	status: WorkstationJobStatus["artifactWriteStatus"];
}> {
	if (!job.terminal) {
		const evidence = buildWorkstationProcessEvidence(c, job, { body });
		return {
			artifactRefs: [],
			evidence,
			status: { reason: "process_not_terminal", status: "skipped" },
		};
	}
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.put !== "function") {
		const evidence = buildWorkstationProcessEvidence(c, job, { body });
		return {
			artifactRefs: [],
			evidence,
			status: { reason: "storage_binding_unavailable", status: "skipped" },
		};
	}

	const artifacts = workstationProcessArtifactRefs(c, job.processId);
	const evidence = buildWorkstationProcessEvidence(c, job, {
		artifactRefs: artifacts.refs,
		body,
	});
	try {
		const uploads = await Promise.allSettled([
			stageWorkstationSpool(
				c.get("sandbox"),
				c.env.TEDI_STORAGE,
				job.stdoutPath,
				artifacts.stdout.key,
			),
			stageWorkstationSpool(
				c.get("sandbox"),
				c.env.TEDI_STORAGE,
				job.stderrPath,
				artifacts.stderr.key,
			),
		]);
		const failed = uploads.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		await c.env.TEDI_STORAGE.put(
			artifacts.evidence.key,
			`${JSON.stringify(evidence, null, 2)}\n`,
			{ httpMetadata: { contentType: "application/json" } },
		);
		return {
			artifactRefs: artifacts.refs,
			evidence,
			status: { status: "persisted" },
		};
	} catch (error) {
		const status = { error: errorMessage(error), status: "failed" as const };
		const partial = {
			...buildWorkstationProcessEvidence(c, job, { body }),
			artifactWriteStatus: status,
		};
		try {
			// Terminal truth survives failed log transport. Create-only prevents a
			// delayed failed upload from replacing a concurrent complete receipt.
			const written = await c.env.TEDI_STORAGE.put(
				artifacts.evidence.key,
				JSON.stringify(partial),
				{
					httpMetadata: { contentType: "application/json" },
					onlyIf: { etagDoesNotMatch: "*" },
				},
			);
			if (!written) {
				const retained = await readPersistedProcessEvidence(c, job.processId);
				if (retained)
					return {
						artifactRefs: retained.artifactRefs,
						evidence: retained,
						status: retained.artifactWriteStatus ?? { status: "persisted" },
					};
			}
		} catch (retentionError) {
			log.error("Terminal receipt retention failed", {
				event: "workstation.receipt_retention_failed",
				leaseId: c.get("workstationRuntimeSelection")?.leaseId ?? undefined,
				outcome: "unavailable",
				error: contentFreeTediException(retentionError),
			});
		}
		return { artifactRefs: [], evidence: partial, status };
	}
}

export function workstationProcessEvidenceMetadata(
	metadata: Record<string, JsonValue>,
	evidence: WorkstationProcessEvidence,
): Record<string, JsonValue> {
	return toJsonRecord({
		...metadata,
		lastWorkstationProcessEvidence: evidence,
		// Keep the hot lease receipt bounded. Full job history is represented by
		// immutable artifact refs and process evidence rows, not an ever-growing
		// JSON object rewritten on every poll.
		workstationProcessEvidence: {
			[evidence.processId]: evidence,
		},
	});
}

export async function persistWorkstationProcessEvidence(
	c: Context<AppEnv>,
	evidence: WorkstationProcessEvidence,
): Promise<
	NonNullable<WorkstationJobStatus["workstationEvidencePersistence"]>
> {
	if (evidence.artifactRefs.length === 0) {
		return { reason: "no_artifact_refs", status: "skipped" };
	}
	if (!c.env.DB) return { reason: "db_binding_unavailable", status: "skipped" };
	try {
		const db = createDbClient(c.env.DB);
		const bundle = await getWorkstationLeaseBundle(db, evidence.leaseId);
		if (!bundle) return { reason: "lease_not_found", status: "skipped" };
		const refs = evidence.artifactRefs;
		const existingSession = bundle.workstationLease.sessions.find(
			(session) => session.id === evidence.sessionId,
		);
		const terminalSession = existingSession
			? {
					...existingSession,
					artifactRefs: uniqueStrings([
						...existingSession.artifactRefs,
						...refs,
					]),
					endedAt: evidence.endedAt ?? new Date().toISOString(),
					metadata: workstationProcessEvidenceMetadata(
						existingSession.metadata,
						evidence,
					),
					status:
						evidence.canceled || evidence.timedOut
							? ("archived" as const)
							: evidence.exitCode === 0
								? ("ready" as const)
								: ("degraded" as const),
				}
			: null;
		const updated = {
			workstation: {
				...bundle.workstation,
				artifactRefs: uniqueStrings([
					...bundle.workstation.artifactRefs,
					...refs,
				]),
				metadata: workstationProcessEvidenceMetadata(
					bundle.workstation.metadata,
					evidence,
				),
			},
			workstationLease: {
				...bundle.workstationLease,
				artifactRefs: uniqueStrings([
					...bundle.workstationLease.artifactRefs,
					...refs,
				]),
				metadata: workstationProcessEvidenceMetadata(
					bundle.workstationLease.metadata,
					evidence,
				),
				// Persist only the session finalized by this job. Replaying the
				// complete lease history made job reads slower after every run.
				sessions: terminalSession ? [terminalSession] : [],
				updatedAt: new Date().toISOString(),
			},
		};
		await upsertWorkstationLeaseBundle(db, updated);
		return { status: "persisted" };
	} catch (error) {
		return { error: errorMessage(error), status: "failed" };
	}
}

export async function promoteWorkstationJobEvidence(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	body: Record<string, unknown> | null,
): Promise<WorkstationJobStatus> {
	const artifactResult = await writeWorkstationProcessArtifacts(c, job, body);
	const artifactRowPersistence = await recordWorkstationProcessArtifactRows(
		c,
		job,
		artifactResult.evidence,
	);
	const evidence = {
		...artifactResult.evidence,
		artifactRefs: uniqueStrings([
			...artifactResult.evidence.artifactRefs,
			...(artifactRowPersistence.artifactIds ?? []).map(
				(artifactId) => `artifact://${artifactId}`,
			),
		]),
	};
	if (
		evidence.artifactRefs.length !==
			artifactResult.evidence.artifactRefs.length &&
		c.env.TEDI_STORAGE
	) {
		const artifacts = workstationProcessArtifactRefs(c, job.processId);
		try {
			await c.env.TEDI_STORAGE.put(
				artifacts.evidence.key,
				`${JSON.stringify(evidence, null, 2)}\n`,
				{ httpMetadata: { contentType: "application/json" } },
			);
		} catch (error) {
			console.warn(
				"[workstation] openable artifact refs could not be added to the persisted receipt:",
				errorMessage(error),
			);
		}
	}
	const persistence = await persistWorkstationProcessEvidence(c, evidence);
	await addWorkItemProcessComment(c, evidence, {
		stdoutTail: job.stdoutTail,
		stderrTail: job.stderrTail,
	});
	return {
		...job,
		artifactRefs: evidence.artifactRefs,
		artifactWriteStatus: artifactResult.status,
		artifactRowPersistence,
		evidence,
		workstationEvidencePersistence: persistence,
	};
}
