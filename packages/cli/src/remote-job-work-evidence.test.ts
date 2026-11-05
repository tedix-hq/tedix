import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { WorkAttemptSchema } from "@tedix/api-contract/schemas/work-items";
import type { ReadJson } from "./hooks/hook-io";
import { RemoteJobRecordSchema } from "./remote-job";
import { workRemoteJobEvidence } from "./remote-job-work-evidence";

function fixture() {
	const scope = {
		workspace: "example",
		organization: "org_example",
		organizationId: randomUUID(),
		workItemId: randomUUID(),
		attemptId: randomUUID(),
		executorId: randomUUID(),
		agentSession: `codex:${randomUUID()}`,
		externalAgent: "example-agent",
		senderUserId: "fictional-owner",
		workUrl: "https://example.test/work/items/example",
	};
	const record = RemoteJobRecordSchema.parse({
		job: {
			organizationId: scope.organizationId,
			workItemId: scope.workItemId,
			attemptId: scope.attemptId,
			jobId: randomUUID(),
			senderUserId: scope.senderUserId,
			adapter: "instinct-email",
			recipient: "member@example.test",
			brief: "Controlled fixture",
		},
		digest: "fixture-job-digest",
		state: "sending",
	});
	const digest = createHash("sha256")
		.update(JSON.stringify(record))
		.digest("hex");
	const attempt = WorkAttemptSchema.parse({
		id: scope.attemptId,
		orgId: scope.organizationId,
		workItemId: scope.workItemId,
		executorType: "external_agent",
		executorId: scope.executorId,
		executorSessionId: randomUUID(),
		externalSessionKey: scope.agentSession,
		runtimeState: "running",
		outcome: null,
		runId: null,
		admissionId: randomUUID(),
		attemptNumber: 1,
		startedAt: new Date(Date.now() - 1000).toISOString(),
		heartbeatAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		finishedAt: null,
		summary: null,
		metadata: {},
	});
	let calls = 0;
	let writes = 0;
	let metadataFile = "";
	let failWrite = false;
	let corruptReceipt = false;
	const read: ReadJson = async (args, _timeout, _input, options) => {
		calls++;
		expect(args.slice(0, 4)).toEqual([
			"--organization",
			scope.organization,
			"--workspace",
			scope.workspace,
		]);
		expect(options?.cwd).toBe(homedir());
		expect(options?.env?.TEDIX_AGENT_SESSION).toBe(scope.agentSession);
		expect(options?.env?.TEDIX_EXTERNAL_AGENT).toBe(scope.externalAgent);
		if (args[5] === "dispatch-attempts")
			return { data: [attempt], nextCursor: null };
		expect(args[5]).toBe("submit-evidence");
		writes++;
		const argument = (flag: string) => args[args.indexOf(flag) + 1]!;
		metadataFile = argument("--evidence-metadata").slice(1);
		const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
		expect(metadata.remoteJob).toEqual(record);
		expect(metadata.snapshotDigest).toBe(digest);
		if (failWrite) throw new Error("ambiguous evidence write");
		return {
			id: randomUUID(),
			orgId: scope.organizationId,
			workItemId: scope.workItemId,
			attemptId: corruptReceipt ? randomUUID() : scope.attemptId,
			claimKey: argument("--claim-key"),
			kind: "remote_job",
			uri: argument("--evidence"),
			digest: null,
			mediaType: null,
			label: argument("--evidence-label"),
			disposition: "pending",
			submittedByType: "external_agent",
			submittedById: scope.executorId,
			submittedBySessionId: attempt.executorSessionId,
			submittedAt: new Date().toISOString(),
			reviewedByType: null,
			reviewedById: null,
			reviewedBySessionId: null,
			reviewedAt: null,
			reviewReason: null,
			version: 1,
			metadata,
		};
	};
	return {
		scope,
		record,
		digest,
		attempt,
		publisher: workRemoteJobEvidence(scope, read, {
			TEDIX_AGENT_SESSION: scope.agentSession,
			TEDIX_EXTERNAL_AGENT: scope.externalAgent,
		}),
		calls: () => calls,
		writes: () => writes,
		metadataFile: () => metadataFile,
		failWrite: () => {
			failWrite = true;
		},
		corruptReceipt: () => {
			corruptReceipt = true;
		},
	};
}

describe("remote job Work evidence", () => {
	it("records the complete snapshot using only the held CLI identity and scope", async () => {
		const f = fixture();
		expect(await f.publisher.publish(f.record, f.digest)).toMatchObject({
			uri: f.scope.workUrl,
		});
		expect(f.calls()).toBe(2);
		expect(f.writes()).toBe(1);
		expect(existsSync(f.metadataFile())).toBe(false);
	});
	it("refuses a mismatched sender or snapshot digest before any remote call", async () => {
		const f = fixture();
		await expect(f.publisher.publish(f.record, "0".repeat(64))).rejects.toThrow(
			"digest mismatch",
		);
		const changed = {
			...f.record,
			job: { ...f.record.job, senderUserId: "other-owner" },
		};
		const digest = createHash("sha256")
			.update(JSON.stringify(changed))
			.digest("hex");
		await expect(f.publisher.publish(changed, digest)).rejects.toThrow(
			"held Work scope",
		);
		expect(f.calls()).toBe(0);
	});
	it.each(["executor", "session", "lease", "admission", "state", "attempt"])(
		"refuses a changed %s before evidence submission",
		async (field) => {
			const f = fixture();
			if (field === "executor") f.attempt.executorId = randomUUID();
			if (field === "session")
				f.attempt.externalSessionKey = `codex:${randomUUID()}`;
			if (field === "lease")
				f.attempt.expiresAt = new Date(Date.now() - 1).toISOString();
			if (field === "admission") f.attempt.admissionId = null;
			if (field === "state") f.attempt.runtimeState = "failed";
			if (field === "attempt") f.attempt.id = randomUUID();
			await expect(f.publisher.publish(f.record, f.digest)).rejects.toThrow(
				"Attempt and lease",
			);
			expect(f.writes()).toBe(0);
		},
	);
	it("never retries an uncertain evidence submission and removes its private buffer", async () => {
		const f = fixture();
		f.failWrite();
		await expect(f.publisher.publish(f.record, f.digest)).rejects.toThrow(
			"ambiguous",
		);
		expect(f.writes()).toBe(1);
		expect(existsSync(f.metadataFile())).toBe(false);
	});
	it("rejects a receipt attached to a different Attempt", async () => {
		const f = fixture();
		f.corruptReceipt();
		await expect(f.publisher.publish(f.record, f.digest)).rejects.toThrow(
			"receipt does not match",
		);
		expect(f.writes()).toBe(1);
	});
});

it("does not replace the host identity with credentials named in job configuration", () => {
	const f = fixture();
	expect(() =>
		workRemoteJobEvidence(f.scope, undefined, {
			TEDIX_AGENT_SESSION: `codex:${randomUUID()}`,
			TEDIX_EXTERNAL_AGENT: f.scope.externalAgent,
		}),
	).toThrow("Held host identity");
	expect(() =>
		workRemoteJobEvidence(f.scope, undefined, {
			TEDIX_AGENT_SESSION: f.scope.agentSession,
			TEDIX_EXTERNAL_AGENT: "other-agent",
		}),
	).toThrow("Held host identity");
});
