import * as z from "zod";
import {
	RemoteJobRecordSchema,
	type RemoteJob,
	type RemoteJobRecord,
} from "./remote-job";
import type { RemoteJobWorkScope } from "./remote-job-work-evidence";

const MailboxScopeSchema = z.object({
	id: z.uuid(),
	tediId: z.uuid(),
	organizationId: z.uuid(),
});
const MessageSchema = MailboxScopeSchema.extend({
	threadId: z.uuid(),
	direction: z.enum(["inbound", "outbound"]),
	subject: z.string(),
	to: z.array(z.object({ email: z.email() })),
	cc: z.array(z.unknown()).nullable().optional(),
	bcc: z.array(z.unknown()).nullable().optional(),
	textBody: z.string().nullable(),
	status: z.enum(["received", "sent", "failed"]),
	providerMessageId: z.string().nullable().optional(),
});
const IntentSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	workItemId: z.uuid(),
	attemptId: z.uuid(),
	kind: z.literal("remote_job"),
	submittedByType: z.literal("external_agent"),
	submittedById: z.string(),
	metadata: z.object({ remoteJob: RemoteJobRecordSchema }),
});
export interface RemoteJobInspection {
	schema: "tedix.remote-job-inspection.v1";
	job: RemoteJob;
	inspectedByAttemptId: string;
	intentEvidenceId: string;
	record: RemoteJobRecord | null;
	providerAcceptance: "confirmed" | "unknown" | "conflicting";
	providerReceipts: {
		threadId: string;
		messageId: string;
		providerMessageId: string;
		proofRef: string;
	}[];
	mailbox: { threadIds: string[]; nextCursor: string | null };
	replayed: false;
}

/** Reports positive mailbox receipts without resolving an uncertain send or publication. */
export async function inspectRemoteJob(input: {
	scope: RemoteJobWorkScope;
	job: RemoteJob;
	memberId: string;
	tediId: string;
	context: unknown;
	record: RemoteJobRecord | undefined;
	call(callable: string, input: unknown): Promise<unknown>;
	verifyAttempt(): Promise<unknown>;
}): Promise<RemoteJobInspection> {
	const { scope, job, memberId, tediId, record, call, verifyAttempt } = input;
	const sameJob = (value: RemoteJob) =>
		JSON.stringify(value) === JSON.stringify(job);
	const { evidence } = z
		.object({ evidence: z.array(z.unknown()) })
		.parse(input.context);
	const intent = evidence.flatMap((value) => {
		const parsed = IntentSchema.safeParse(value);
		if (!parsed.success) return [];
		const row = parsed.data;
		return row.orgId === scope.organizationId &&
			row.workItemId === scope.workItemId &&
			row.attemptId === job.attemptId &&
			row.submittedById === scope.executorId &&
			sameJob(row.metadata.remoteJob.job)
			? [row]
			: [];
	})[0];
	if (!intent)
		throw new Error(
			"No matching original Work evidence in the returned page; reconciliation required",
		);
	if (record && !sameJob(record.job))
		throw new Error("Recovery record does not match the original job");
	const inbox = z
		.object({
			threads: z.array(MailboxScopeSchema).max(10),
			nextCursor: z.string().nullable(),
		})
		.parse(
			await call("tedis.list_tedi_email_inbox", {
				tediId,
				status: "all",
				query: `Tedix controlled job ${job.jobId}`,
				limit: 10,
			}),
		);
	const receipts: RemoteJobInspection["providerReceipts"] = [];
	for (const summary of inbox.threads) {
		if (
			summary.organizationId !== job.organizationId ||
			summary.tediId !== tediId
		)
			throw new Error("Mailbox thread scope mismatch");
		await verifyAttempt();
		const { thread, messages } = z
			.object({
				thread: MailboxScopeSchema,
				messages: z.array(MessageSchema),
			})
			.parse(
				await call("tedis.read_thread", {
					tediId,
					threadId: summary.id,
					markRead: false,
				}),
			);
		if (
			thread.id !== summary.id ||
			thread.organizationId !== job.organizationId ||
			thread.tediId !== tediId ||
			messages.some(
				(message) =>
					message.threadId !== thread.id ||
					message.organizationId !== job.organizationId ||
					message.tediId !== tediId,
			)
		)
			throw new Error("Mailbox thread scope mismatch");
		for (const message of messages) {
			if (
				message.direction !== "outbound" ||
				message.subject !== `Tedix controlled job ${job.jobId}` ||
				message.to.length !== 1 ||
				message.to[0]?.email !== job.recipient ||
				message.cc?.length ||
				message.bcc?.length ||
				message.status !== "sent" ||
				!message.providerMessageId?.trim() ||
				!message.textBody
			)
				continue;
			let body: unknown;
			try {
				body = JSON.parse(message.textBody);
			} catch {
				continue;
			}
			const envelope = z
				.object({
					schema: z.literal("tedix.remote-job.v1"),
					memberId: z.literal(memberId),
					job: RemoteJobRecordSchema.shape.job,
				})
				.safeParse(body);
			if (!envelope.success || !sameJob(envelope.data.job)) continue;
			receipts.push({
				threadId: thread.id,
				messageId: message.id,
				providerMessageId: message.providerMessageId,
				proofRef: `tedix://organizations/${job.organizationId}/tedis/${tediId}/email/threads/${thread.id}/messages/${message.id}`,
			});
		}
	}
	return {
		schema: "tedix.remote-job-inspection.v1",
		job,
		inspectedByAttemptId: scope.attemptId,
		intentEvidenceId: intent.id,
		record: record ?? null,
		providerAcceptance:
			receipts.length > 1
				? "conflicting"
				: receipts.length === 1
					? "confirmed"
					: "unknown",
		providerReceipts: receipts,
		mailbox: {
			threadIds: inbox.threads.map((thread) => thread.id),
			nextCursor: inbox.nextCursor,
		},
		replayed: false,
	};
}
