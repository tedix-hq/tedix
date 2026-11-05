import { createHash } from "node:crypto";
import * as z from "zod";

export const remoteAdapterOrder = [
	"instinct-email",
	"claude-cloud",
	"devin-cloud",
	"codex-cloud",
] as const;
const text = z.string().trim().min(1).max(2000);
const correlation = {
	organizationId: z.uuid(),
	workItemId: z.uuid(),
	attemptId: z.uuid(),
	jobId: z.uuid(),
	senderUserId: text,
	adapter: z.enum(remoteAdapterOrder),
};
const JobSchema = z.strictObject({
	...correlation,
	recipient: z.email(),
	brief: text,
});
export type RemoteJob = z.infer<typeof JobSchema>;
export type RemoteJobKey = Pick<RemoteJob, "organizationId" | "jobId">;
const ReceiptSchema = z.strictObject({ providerJobId: text, proofRef: text });
export const RemoteJobEventSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...correlation,
		kind: z.literal("heartbeat"),
		providerJobId: text,
		eventId: text,
		observedAt: z.iso.datetime(),
		proofRef: text,
	}),
	z.strictObject({
		...correlation,
		kind: z.literal("result"),
		providerJobId: text,
		eventId: text,
		observedAt: z.iso.datetime(),
		proofRef: text,
		outcome: z.enum(["succeeded", "failed"]),
		result: text,
	}),
]);
export type RemoteJobEvent = z.infer<typeof RemoteJobEventSchema>;
export const RemoteJobRecordSchema = z.strictObject({
	job: JobSchema,
	digest: text,
	state: z.enum(["sending", "unknown", "sent", "succeeded", "failed"]),
	receipt: ReceiptSchema.optional(),
	heartbeat: RemoteJobEventSchema.options[0].optional(),
	result: RemoteJobEventSchema.options[1].optional(),
	publication: z
		.strictObject({
			snapshotDigest: text,
			status: z.enum(["publishing", "published", "unknown"]),
			evidenceId: z.uuid().optional(),
			uri: text.optional(),
		})
		.optional(),
});
export type RemoteJobRecord = z.infer<typeof RemoteJobRecordSchema>;

/** Implementations must serialize updates across processes and retain intent after a crash. */
export interface RemoteJobStore {
	read(job: RemoteJobKey): RemoteJobRecord | undefined;
	update(
		job: RemoteJobKey,
		change: (current: RemoteJobRecord | undefined) => RemoteJobRecord,
	): RemoteJobRecord;
}
export interface RemoteJobTransport {
	/** The transport must preserve the job envelope and return a provider receipt. */
	sendJob(job: RemoteJob): Promise<z.infer<typeof ReceiptSchema>>;
}
export interface RemoteJobEvidence {
	publish(
		record: RemoteJobRecord,
		snapshotDigest: string,
	): Promise<{ id: string; uri: string }>;
}
export type RemoteConnection =
	| { status: "available"; transport: RemoteJobTransport; testMailbox: string }
	| { status: "unavailable"; reason: string };
export interface RemoteJobAdapter {
	id: RemoteJob["adapter"];
	availability:
		| { status: "available" }
		| { status: "unavailable"; reason: string };
	sendJob(job: RemoteJob): Promise<RemoteJobRecord>;
	receiveResult(event: RemoteJobEvent): Promise<RemoteJobRecord>;
}
function digest(job: RemoteJob) {
	return createHash("sha256")
		.update(JSON.stringify(JobSchema.parse(job)))
		.digest("hex");
}
function sameJob(record: RemoteJobRecord, job: RemoteJob) {
	if (record.digest !== digest(job))
		throw new Error("Job identity or payload changed; reconciliation required");
}

export function createRemoteJobAdapter(
	id: RemoteJob["adapter"],
	store: RemoteJobStore,
	connection: RemoteConnection,
	evidence: RemoteJobEvidence,
): RemoteJobAdapter {
	function snapshot(record: RemoteJobRecord) {
		const { publication: _, ...value } = record;
		return value;
	}
	function snapshotDigest(record: RemoteJobRecord) {
		return createHash("sha256")
			.update(JSON.stringify(snapshot(record)))
			.digest("hex");
	}
	async function publish(record: RemoteJobRecord): Promise<RemoteJobRecord> {
		const digest = snapshotDigest(record);
		const reserved = store.update(record.job, (current) => {
			if (!current || snapshotDigest(current) !== digest)
				throw new Error("Job changed before evidence publication");
			if (current.publication?.snapshotDigest === digest) {
				if (current.publication.status === "published") return current;
				throw new Error(
					"Evidence publication uncertain or in progress; reconciliation required",
				);
			}
			return {
				...current,
				publication: { snapshotDigest: digest, status: "publishing" },
			};
		});
		if (reserved.publication?.status === "published") return reserved;
		let receipt: { id: string; uri: string };
		try {
			receipt = z
				.strictObject({ id: z.uuid(), uri: text })
				.parse(await evidence.publish(snapshot(reserved), digest));
		} catch (error) {
			store.update(record.job, (current) => {
				if (!current || current.publication?.snapshotDigest !== digest)
					throw new Error("Job changed during evidence publication");
				return {
					...current,
					publication: { snapshotDigest: digest, status: "unknown" },
				};
			});
			throw error;
		}
		return store.update(record.job, (current) => {
			if (!current || snapshotDigest(current) !== digest)
				throw new Error("Job changed during evidence publication");
			return {
				...current,
				publication: {
					snapshotDigest: digest,
					status: "published",
					evidenceId: receipt.id,
					uri: receipt.uri,
				},
			};
		});
	}
	return {
		id,
		availability:
			connection.status === "available" ? { status: "available" } : connection,
		async sendJob(input) {
			const job = JobSchema.parse(input);
			if (job.adapter !== id) throw new Error("Adapter mismatch");
			if (connection.status !== "available")
				throw new Error(`Unavailable: ${connection.reason}`);
			if (job.recipient !== z.email().parse(connection.testMailbox))
				throw new Error("Only the configured test mailbox is allowed");
			const prior = store.read(job);
			if (prior) {
				sameJob(prior, job);
				return publish(prior);
			}
			// Persist before the external call. Neither a crash nor an ambiguous response permits replay.
			const intent = store.update(job, (current) => {
				if (current)
					throw new Error("Job already reserved; read its existing result");
				return { job, digest: digest(job), state: "sending" };
			});
			await publish(intent);
			let receipt: z.infer<typeof ReceiptSchema>;
			try {
				receipt = ReceiptSchema.parse(await connection.transport.sendJob(job));
			} catch {
				return publish(
					store.update(job, (current) => {
						if (!current) throw new Error("Missing send intent");
						return { ...current, state: "unknown" };
					}),
				);
			}
			return publish(
				store.update(job, (current) => {
					if (!current || current.state !== "sending")
						throw new Error("Send intent changed; reconciliation required");
					return { ...current, state: "sent", receipt };
				}),
			);
		},
		async receiveResult(input) {
			// Only an authenticated transport may supply an event; the envelope itself is not authentication.
			const event = RemoteJobEventSchema.parse(input);
			if (event.adapter !== id) throw new Error("Adapter mismatch");
			return publish(
				store.update(event, (current) => {
					if (!current?.receipt)
						throw new Error(
							"No confirmed provider job; reconciliation required",
						);
					if (current.publication && current.publication.status !== "published")
						throw new Error(
							"Evidence publication uncertain or in progress; reconciliation required",
						);
					for (const field of Object.keys(
						correlation,
					) as (keyof typeof correlation)[]) {
						if (event[field] !== current.job[field])
							throw new Error("Event correlation mismatch");
					}
					if (event.providerJobId !== current.receipt.providerJobId)
						throw new Error("Provider job mismatch");
					const previous =
						event.kind === "result" ? current.result : current.heartbeat;
					if (previous?.eventId === event.eventId) {
						if (JSON.stringify(previous) !== JSON.stringify(event))
							throw new Error("Conflicting duplicate event");
						return current;
					}
					if (current.result)
						throw new Error("Job already has a terminal result");
					if (
						current.heartbeat &&
						Date.parse(event.observedAt) <
							Date.parse(current.heartbeat.observedAt)
					)
						throw new Error("Stale event");
					return event.kind === "heartbeat"
						? { ...current, heartbeat: event }
						: { ...current, state: event.outcome, result: event };
				}),
			);
		},
	};
}

export function createInstinctEmailAdapter(
	store: RemoteJobStore,
	connection: RemoteConnection,
	evidence: RemoteJobEvidence,
) {
	return createRemoteJobAdapter("instinct-email", store, connection, evidence);
}
