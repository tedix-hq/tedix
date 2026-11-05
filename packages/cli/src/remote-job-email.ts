import * as z from "zod";
import {
	RemoteJobEventSchema,
	type RemoteJob,
	type RemoteJobTransport,
} from "./remote-job";

/** Provider reads must verify the sender, not merely copy an untrusted From header. */
export interface RemoteJobMailClient {
	send(message: {
		to: string;
		subject: string;
		body: string;
	}): Promise<{ messageId: string; threadId: string; proofRef: string }>;
	read(messageId: string): Promise<{
		messageId: string;
		from: string;
		threadId: string;
		receivedAt: string;
		senderVerified: boolean;
		body: string;
		proofRef: string;
	}>;
}

export function createInstinctEmailTransport(
	binding: {
		organizationId: string;
		memberId: string;
		memberEmail: string;
		testMailbox: string;
	},
	mail: RemoteJobMailClient,
) {
	z.uuid().parse(binding.organizationId);
	z.string().trim().min(1).parse(binding.memberId);
	const memberEmail = z.email().parse(binding.memberEmail);
	const mailbox = z.email().parse(binding.testMailbox);
	const transport: RemoteJobTransport = {
		async sendJob(job: RemoteJob) {
			if (
				job.adapter !== "instinct-email" ||
				job.organizationId !== binding.organizationId ||
				job.recipient !== mailbox ||
				mailbox !== memberEmail
			) {
				throw new Error(
					"A verified organization member test mailbox is required",
				);
			}
			const sent = await mail.send({
				to: mailbox,
				subject: `Tedix controlled job ${job.jobId}`,
				body: JSON.stringify({
					schema: "tedix.remote-job.v1",
					memberId: binding.memberId,
					job,
				}),
			});
			z.string().trim().min(1).parse(sent.messageId);
			return { providerJobId: sent.threadId, proofRef: sent.proofRef };
		},
	};
	return {
		...transport,
		async receiveResult(messageId: string) {
			const message = await mail.read(
				z.string().trim().min(1).parse(messageId),
			);
			if (!message.senderVerified || message.from !== memberEmail)
				throw new Error("Unverified member email sender");
			if (message.messageId !== messageId)
				throw new Error("Email correlation mismatch");
			const body = z
				.record(z.string(), z.unknown())
				.parse(JSON.parse(message.body));
			// Provider IDs, timestamps and proof come from the read, never the reply body.
			const event = RemoteJobEventSchema.parse({
				...body,
				providerJobId: message.threadId,
				eventId: message.messageId,
				observedAt: message.receivedAt,
				proofRef: message.proofRef,
			});
			if (
				event.organizationId !== binding.organizationId ||
				event.adapter !== "instinct-email"
			) {
				throw new Error("Email correlation mismatch");
			}
			return event;
		},
	};
}
