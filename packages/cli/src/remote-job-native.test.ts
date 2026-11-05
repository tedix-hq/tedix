import { afterEach, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadJson } from "./hooks/hook-io";
import { runNativeRemoteJob, runRemoteJobCommand } from "./remote-job-native";
import type { RemoteJobRecord } from "./remote-job";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "remote-native-test-"));
	directories.push(directory);
	const scope = {
		workspace: "example",
		organization: "org_example",
		organizationId: randomUUID(),
		workItemId: randomUUID(),
		attemptId: randomUUID(),
		executorId: randomUUID(),
		agentSession: `codex:${randomUUID()}`,
		externalAgent: "fictional-agent",
		senderUserId: "fictional-owner",
		workUrl: "https://example.test/work/items/example",
	};
	const job = {
		organizationId: scope.organizationId,
		workItemId: scope.workItemId,
		attemptId: scope.attemptId,
		jobId: randomUUID(),
		senderUserId: scope.senderUserId,
		adapter: "instinct-email" as const,
		recipient: "member@example.test",
		brief: "Return controlled test proof",
	};
	const input = { scope, job, memberId: randomUUID(), tediId: randomUUID() };
	const env = {
		TEDIX_AGENT_SESSION: scope.agentSession,
		TEDIX_EXTERNAL_AGENT: scope.externalAgent,
		TEDIX_CONFIG_DIR: directory,
	};
	const attempt = {
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
		startedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		finishedAt: null,
		summary: null,
		metadata: {},
	};
	const member = {
		id: input.memberId,
		organizationId: scope.organizationId,
		email: job.recipient,
		status: "active",
		kind: "external_agent",
		representedUserId: job.senderUserId,
	};
	const work = {
		id: job.workItemId,
		orgId: job.organizationId,
		disposition: "accepted",
		accountableOwnerType: "user",
		accountableOwnerId: job.senderUserId,
	};
	const thread = {
		id: randomUUID(),
		organizationId: scope.organizationId,
		tediId: input.tediId,
		senderTrust: "trusted",
	};
	const messages: {
		id: string;
		threadId: string;
		tediId: string;
		organizationId: string;
		direction: string;
		fromAddr: string;
		receivedAt: string;
		textBody: string;
	}[] = [];
	const published: RemoteJobRecord[] = [];
	const sent: unknown[] = [];
	let failSend = false,
		failEvidence = false;
	const read: ReadJson = async (args, _timeout, _stdin, options) => {
		expect(options?.cwd).toBe(homedir());
		expect(options?.env?.TEDIX_AGENT_SESSION).toBe(scope.agentSession);
		expect(options?.env?.TEDIX_EXTERNAL_AGENT).toBe(scope.externalAgent);
		expect(args).toContain(scope.organization);
		expect(args).toContain(scope.workspace);
		const argument = (key: string) => args[args.indexOf(key) + 1]!;
		if (args.includes("dispatch-attempts")) return { data: [attempt] };
		if (args.includes("dispatch-get"))
			return {
				workItem: work,
				evidence: published.map((record) => ({
					id: randomUUID(),
					orgId: scope.organizationId,
					workItemId: scope.workItemId,
					attemptId: record.job.attemptId,
					kind: "remote_job",
					submittedByType: "external_agent",
					submittedById: scope.executorId,
					metadata: { remoteJob: record },
				})),
			};
		if (args.includes("submit-evidence")) {
			const metadata = JSON.parse(
				readFileSync(argument("--evidence-metadata").slice(1), "utf8"),
			);
			published.push(metadata.remoteJob);
			if (failEvidence) throw new Error("ambiguous publication");
			return {
				id: randomUUID(),
				orgId: scope.organizationId,
				workItemId: scope.workItemId,
				attemptId: scope.attemptId,
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
		}
		const script = args[args.indexOf("code") + 1]!;
		const match = script.match(/^async \(\) => await ([a-z_.]+)\((.*)\)$/)!;
		const params = JSON.parse(match[2]!);
		switch (match[1]) {
			case "members.get_member":
				expect(params.memberId).toBe(input.memberId);
				return { data: member };
			case "tedis.list_tedi_email_inbox":
				expect(params.tediId).toBe(input.tediId);
				return { threads: [], nextCursor: null };
			case "tedis.send_email":
				expect(published.at(-1)?.state).toBe("sending");
				sent.push(params);
				if (failSend) throw new Error("unknown provider result");
				return {
					ok: true,
					sent: true,
					provider: "cloudflare",
					messageId: "provider-message",
					emailMessageId: randomUUID(),
					threadId: thread.id,
				};
			case "tedis.read_thread":
				expect(params).toEqual({
					tediId: input.tediId,
					threadId: thread.id,
					markRead: false,
				});
				return { thread, messages };
			default:
				throw new Error(`Unexpected call: ${script}`);
		}
	};
	function reply(kind: "heartbeat" | "result", time: number) {
		const { recipient: _, brief: __, ...correlation } = job;
		messages.push({
			id: randomUUID(),
			threadId: thread.id,
			tediId: input.tediId,
			organizationId: scope.organizationId,
			direction: "inbound",
			fromAddr: job.recipient,
			receivedAt: new Date(time).toISOString(),
			textBody: JSON.stringify({
				...correlation,
				kind,
				...(kind === "result"
					? { outcome: "succeeded", result: "Transport proof" }
					: {}),
			}),
		});
	}
	return {
		input,
		env,
		attempt,
		member,
		work,
		thread,
		messages,
		sent,
		published,
		reply,
		failSend: () => {
			failSend = true;
		},
		failEvidence: () => {
			failEvidence = true;
		},
		directory,
		inspect: () => runNativeRemoteJob("inspect", input, read, env),
		run: (operation: "send" | "receive") =>
			runNativeRemoteJob(operation, input, read, env),
	};
}

it("consumes verified mailbox heartbeat and result into Work evidence across passes", async () => {
	const f = fixture();
	expect((await f.run("send")).state).toBe("sent");
	expect((await f.run("send")).state).toBe("sent");
	expect(f.sent).toHaveLength(1);
	f.reply("heartbeat", 1000);
	f.reply("heartbeat", 2000);
	expect((await f.run("receive")).heartbeat?.eventId).toBe(f.messages[1]!.id);
	f.reply("result", 3000);
	const result = await f.run("receive");
	expect(result).toMatchObject({
		state: "succeeded",
		job: f.input.job,
		heartbeat: { eventId: f.messages[1]!.id },
		result: { eventId: f.messages[2]!.id, result: "Transport proof" },
	});
	expect(result.publication?.status).toBe("published");
	expect(f.published.at(-1)?.result).toEqual(result.result);
	expect(await f.run("receive")).toEqual(result);
});
it("retains unknown sends and ambiguous Work writes without replay", async () => {
	const f = fixture();
	f.failSend();
	expect((await f.run("send")).state).toBe("unknown");
	expect((await f.run("send")).state).toBe("unknown");
	expect(f.sent).toHaveLength(1);
	const g = fixture();
	g.failEvidence();
	await expect(g.run("send")).rejects.toThrow("ambiguous publication");
	await expect(g.run("send")).rejects.toThrow("reconciliation required");
	expect(g.sent).toHaveLength(0);
});
it("refuses expired admission, changed owner and a different member mailbox before sending", async () => {
	for (const change of ["lease", "owner", "member"] as const) {
		const f = fixture();
		if (change === "lease") f.attempt.expiresAt = new Date(0).toISOString();
		if (change === "owner") f.work.accountableOwnerId = "other-owner";
		if (change === "member") f.member.email = "other@example.test";
		await expect(f.run("send")).rejects.toThrow();
		expect(f.sent).toHaveLength(0);
		expect(f.published).toHaveLength(0);
	}
});
it("rejects cross-organization threads and messages, untrusted mail and forged From before result publication", async () => {
	for (const change of ["thread", "message", "trust", "from"] as const) {
		const f = fixture();
		await f.run("send");
		f.reply("result", 1000);
		if (change === "thread") f.thread.organizationId = randomUUID();
		if (change === "message") f.messages[0]!.organizationId = randomUUID();
		if (change === "trust") f.thread.senderTrust = "untrusted";
		if (change === "from") f.messages[0]!.fromAddr = "attacker@example.test";
		await expect(f.run("receive")).rejects.toThrow();
		expect(f.published).toHaveLength(2);
	}
});
it("orders provider timestamps chronologically across fractional precision", async () => {
	const f = fixture();
	await f.run("send");
	f.reply("heartbeat", 1000);
	f.reply("result", 1100);
	f.messages[0]!.receivedAt = "1970-01-01T00:00:01Z";
	f.messages.reverse();
	expect((await f.run("receive")).state).toBe("succeeded");
});
it("requires explicit CLI operation and selectors", async () => {
	await expect(runRemoteJobCommand(["send"])).rejects.toThrow("required");
	await expect(runRemoteJobCommand(["send", "--unexpected"])).rejects.toThrow(
		"Unknown",
	);
});

it("inspects an older unknown job under fresh admission without rewriting or replaying it", async () => {
	const f = fixture();
	f.failSend();
	const unknown = await f.run("send");
	const originalAttemptId = f.input.job.attemptId;
	f.input.scope.attemptId = randomUUID();
	f.attempt.id = f.input.scope.attemptId;
	const contents = () =>
		readdirSync(join(f.directory, "remote-jobs")).map((file) =>
			readFileSync(join(f.directory, "remote-jobs", file), "utf8"),
		);
	const before = contents();
	expect(await f.inspect()).toMatchObject({
		job: { attemptId: originalAttemptId },
		inspectedByAttemptId: f.input.scope.attemptId,
		record: unknown,
		providerAcceptance: "unknown",
		providerReceipts: [],
		mailbox: { threadIds: [], nextCursor: null },
		replayed: false,
	});
	expect(contents()).toEqual(before);
	expect(f.sent).toHaveLength(1);
	expect(f.published).toHaveLength(2);
	await expect(f.run("send")).rejects.toThrow("held Instinct Work scope");
	await expect(f.run("receive")).rejects.toThrow("held Instinct Work scope");
});

it("requires original Work evidence and current admission before inspecting", async () => {
	const f = fixture();
	await expect(f.inspect()).rejects.toThrow(
		"No matching original Work evidence",
	);
	await f.run("send");
	f.attempt.expiresAt = new Date(0).toISOString();
	await expect(f.inspect()).rejects.toThrow("Current admitted Attempt");
	expect(f.sent).toHaveLength(1);
	expect(f.published).toHaveLength(2);
});
