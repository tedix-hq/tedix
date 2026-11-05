import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { inspectRemoteJob } from "./remote-job-inspect";

function fixture() {
	const job = {
		organizationId: randomUUID(),
		workItemId: randomUUID(),
		attemptId: randomUUID(),
		jobId: randomUUID(),
		senderUserId: "fictional-owner",
		adapter: "instinct-email" as const,
		recipient: "member@example.test",
		brief: "Controlled test",
	};
	const scope = {
		...job,
		workspace: "example",
		organization: "org_example",
		attemptId: randomUUID(),
		executorId: randomUUID(),
		agentSession: `codex:${randomUUID()}`,
		externalAgent: "fictional-agent",
		workUrl: "https://example.test/work",
	};
	const record = {
		job,
		digest: "retained",
		state: "unknown" as const,
		publication: { snapshotDigest: "retained", status: "unknown" as const },
	};
	const intent = {
		id: randomUUID(),
		orgId: job.organizationId,
		workItemId: job.workItemId,
		attemptId: job.attemptId,
		kind: "remote_job",
		submittedByType: "external_agent",
		submittedById: scope.executorId,
		metadata: { remoteJob: record },
	};
	const memberId = randomUUID(),
		tediId = randomUUID();
	const thread = {
		id: randomUUID(),
		organizationId: job.organizationId,
		tediId,
	};
	const message = {
		id: randomUUID(),
		threadId: thread.id,
		tediId,
		organizationId: job.organizationId,
		direction: "outbound",
		subject: `Tedix controlled job ${job.jobId}`,
		to: [{ email: job.recipient }],
		cc: [] as unknown[],
		bcc: [] as unknown[],
		status: "sent",
		providerMessageId: "provider-confirmed",
		textBody: JSON.stringify({ schema: "tedix.remote-job.v1", memberId, job }),
	};
	const messages = [message];
	const inbox = { threads: [thread], nextCursor: null as string | null };
	const calls: string[] = [];
	let leaseExpired = false;
	return {
		job,
		scope,
		record,
		intent,
		thread,
		message,
		messages,
		inbox,
		calls,
		expireLease: () => {
			leaseExpired = true;
		},
		run: () =>
			inspectRemoteJob({
				scope,
				job,
				record,
				memberId,
				tediId,
				context: { evidence: [intent] },
				verifyAttempt: async () => {
					if (leaseExpired) throw new Error("expired");
				},
				call: async (callable, input) => {
					calls.push(callable);
					if (callable === "tedis.list_tedi_email_inbox") {
						expect(input).toEqual({
							tediId,
							status: "all",
							query: `Tedix controlled job ${job.jobId}`,
							limit: 10,
						});
						return inbox;
					}
					expect(callable).toBe("tedis.read_thread");
					expect(input).toEqual({
						tediId,
						threadId: thread.id,
						markRead: false,
					});
					return { thread, messages };
				},
			}),
	};
}

it("reports an exact stored provider receipt without resolving unknown recovery or publication state", async () => {
	const f = fixture();
	const before = JSON.stringify(f.record);
	const result = await f.run();
	expect(result).toMatchObject({
		providerAcceptance: "confirmed",
		replayed: false,
		intentEvidenceId: f.intent.id,
		inspectedByAttemptId: f.scope.attemptId,
		job: f.job,
		record: f.record,
		providerReceipts: [
			{
				threadId: f.thread.id,
				messageId: f.message.id,
				providerMessageId: "provider-confirmed",
			},
		],
	});
	expect(result.providerReceipts[0]?.proofRef).toContain(
		`/messages/${f.message.id}`,
	);
	expect(JSON.stringify(f.record)).toBe(before);
	expect(f.calls).toEqual(["tedis.list_tedi_email_inbox", "tedis.read_thread"]);
});

it("never treats a subject match, failed send, inbound text or changed envelope as acceptance", async () => {
	for (const change of [
		"recipient",
		"cc",
		"status",
		"direction",
		"provider",
		"json",
		"job",
		"member",
		"subject",
	] as const) {
		const f = fixture();
		if (change === "recipient") f.message.to[0]!.email = "other@example.test";
		if (change === "cc") f.message.cc.push({ email: "other@example.test" });
		if (change === "status") f.message.status = "failed";
		if (change === "direction") f.message.direction = "inbound";
		if (change === "provider") f.message.providerMessageId = "";
		if (change === "json") f.message.textBody = "not json";
		if (change === "subject") f.message.subject = "another job";
		if (change === "job" || change === "member") {
			const envelope = JSON.parse(f.message.textBody);
			if (change === "job") envelope.job.attemptId = randomUUID();
			else envelope.memberId = randomUUID();
			f.message.textBody = JSON.stringify(envelope);
		}
		expect((await f.run()).providerAcceptance).toBe("unknown");
	}
});

it("reports conflicting receipts and incomplete mailbox pages without replay", async () => {
	const f = fixture();
	f.messages.push({
		...f.message,
		id: randomUUID(),
		providerMessageId: "second-provider-send",
	});
	f.inbox.nextCursor = "more-mail";
	expect(await f.run()).toMatchObject({
		providerAcceptance: "conflicting",
		mailbox: { nextCursor: "more-mail" },
		replayed: false,
	});
	const g = fixture();
	g.inbox.threads = [];
	g.inbox.nextCursor = "more-mail";
	expect(await g.run()).toMatchObject({
		providerAcceptance: "unknown",
		mailbox: { nextCursor: "more-mail" },
		replayed: false,
	});
});

it("rejects changed Work evidence, recovery records, mailbox scopes and expired leases", async () => {
	for (const change of [
		"evidence",
		"record",
		"thread",
		"message",
		"lease",
	] as const) {
		const f = fixture();
		if (change === "evidence") f.intent.submittedById = randomUUID();
		if (change === "record") f.record.job = { ...f.job, brief: "changed" };
		if (change === "thread") f.thread.organizationId = randomUUID();
		if (change === "message") f.message.threadId = randomUUID();
		if (change === "lease") f.expireLease();
		await expect(f.run()).rejects.toThrow();
	}
});
