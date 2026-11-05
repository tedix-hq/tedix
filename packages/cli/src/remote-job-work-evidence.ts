import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import {
	WorkAttemptSchema,
	WorkEvidenceSchema,
} from "@tedix/api-contract/schemas/work-items";
import { cliRead, type ReadJson } from "./hooks/hook-io";
import { RemoteJobRecordSchema, type RemoteJobEvidence } from "./remote-job";

const ScopeSchema = z.strictObject({
	workspace: z.string().min(1),
	organization: z.string().min(1),
	organizationId: z.uuid(),
	workItemId: z.uuid(),
	attemptId: z.uuid(),
	executorId: z.string().min(1),
	agentSession: z.string().min(1),
	externalAgent: z.string().min(1),
	senderUserId: z.string().min(1),
	workUrl: z.url().refine((url) => new URL(url).protocol === "https:"),
});
export type RemoteJobWorkScope = z.infer<typeof ScopeSchema>;

/** Uses the held CLI identity and Attempt; never admits, heartbeats or settles one. */
export function workRemoteJobEvidence(
	input: RemoteJobWorkScope,
	read: ReadJson = cliRead,
	env: NodeJS.ProcessEnv = process.env,
): RemoteJobEvidence {
	const scope = ScopeSchema.parse(input);
	if (
		env.TEDIX_AGENT_SESSION !== scope.agentSession ||
		env.TEDIX_EXTERNAL_AGENT !== scope.externalAgent
	)
		throw new Error("Held host identity does not match the Work scope");
	const selectors = [
		"--organization",
		scope.organization,
		"--workspace",
		scope.workspace,
	];
	const options = {
		cwd: homedir(),
		env: { ...env },
	};
	return {
		async publish(value, snapshotDigest) {
			const record = RemoteJobRecordSchema.parse(value);
			if (
				createHash("sha256").update(JSON.stringify(record)).digest("hex") !==
				snapshotDigest
			)
				throw new Error("Job snapshot digest mismatch");
			const job = record.job;
			if (
				job.organizationId !== scope.organizationId ||
				job.workItemId !== scope.workItemId ||
				job.attemptId !== scope.attemptId ||
				job.senderUserId !== scope.senderUserId
			) {
				throw new Error("Remote job does not match the held Work scope");
			}
			const history = await read(
				[
					...selectors,
					"work",
					"dispatch-attempts",
					"--input",
					JSON.stringify({ id: scope.workItemId, limit: 1 }),
					"--json",
				],
				60_000,
				undefined,
				options,
			);
			const attempt = z
				.object({ data: z.array(WorkAttemptSchema).min(1) })
				.parse(history).data[0]!;
			if (
				attempt.id !== scope.attemptId ||
				attempt.orgId !== scope.organizationId ||
				attempt.workItemId !== scope.workItemId ||
				attempt.executorType !== "external_agent" ||
				attempt.executorId !== scope.executorId ||
				attempt.externalSessionKey !== scope.agentSession ||
				attempt.runtimeState !== "running" ||
				attempt.outcome !== null ||
				!attempt.admissionId ||
				!attempt.executorSessionId ||
				!attempt.expiresAt ||
				Date.parse(attempt.expiresAt) <= Date.now()
			) {
				throw new Error(
					"Current admitted Attempt and lease could not be verified",
				);
			}
			const claimKey = `remote-job:${job.jobId}:${z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.parse(snapshotDigest)}`;
			const uri =
				record.result?.proofRef ?? record.receipt?.proofRef ?? scope.workUrl;
			const metadata = {
				schema: "tedix.remote-job.v1",
				snapshotDigest,
				remoteJob: record,
			};
			const directory = mkdtempSync(join(tmpdir(), "tedix-remote-evidence-"));
			const file = join(directory, "metadata.json");
			try {
				writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
				const result = WorkEvidenceSchema.parse(
					await read(
						[
							...selectors,
							"work",
							"submit-evidence",
							scope.workItemId,
							"--claim-key",
							claimKey,
							"--evidence-kind",
							"remote_job",
							"--evidence",
							uri,
							"--evidence-label",
							`${job.adapter}: ${record.state}`,
							"--evidence-metadata",
							`@${file}`,
							"--json",
						],
						60_000,
						undefined,
						options,
					),
				);
				if (
					result.orgId !== scope.organizationId ||
					result.workItemId !== scope.workItemId ||
					result.attemptId !== scope.attemptId ||
					result.submittedByType !== "external_agent" ||
					result.submittedById !== scope.executorId ||
					result.submittedBySessionId !== attempt.executorSessionId ||
					result.kind !== "remote_job" ||
					result.claimKey !== claimKey ||
					result.uri !== uri ||
					result.metadata.snapshotDigest !== snapshotDigest ||
					JSON.stringify(result.metadata.remoteJob) !== JSON.stringify(record)
				) {
					throw new Error(
						"Work evidence receipt does not match the submitted job snapshot",
					);
				}
				return { id: result.id, uri: result.uri };
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	};
}
