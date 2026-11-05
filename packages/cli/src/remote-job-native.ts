import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { cliRead, type ReadJson } from "./hooks/hook-io";
import { createInstinctEmailTransport } from "./remote-job-email";
import {
	createInstinctEmailAdapter,
	RemoteJobRecordSchema,
} from "./remote-job";
import { fileRemoteJobStore } from "./remote-job-store";
import {
	RemoteJobWorkScopeSchema,
	workRemoteJobEvidence,
} from "./remote-job-work-evidence";

const InputSchema = z.strictObject({
	scope: RemoteJobWorkScopeSchema,
	job: RemoteJobRecordSchema.shape.job,
	memberId: z.uuid(),
	tediId: z.uuid(),
});
const MessageSchema = z.object({
	id: z.uuid(),
	threadId: z.uuid(),
	tediId: z.uuid(),
	organizationId: z.uuid(),
	direction: z.enum(["inbound", "outbound"]),
	fromAddr: z.email(),
	receivedAt: z.iso.datetime().nullable(),
	textBody: z.string().nullable(),
});
const ThreadSchema = z.object({
	thread: z.object({
		id: z.uuid(),
		tediId: z.uuid(),
		organizationId: z.uuid(),
		senderTrust: z.enum(["trusted", "untrusted"]),
	}),
	messages: z.array(MessageSchema),
});

/** One explicit send or receive pass. The caller retains Attempt lifecycle ownership. */
export async function runNativeRemoteJob(
	operation: "send" | "receive",
	value: unknown,
	read: ReadJson = cliRead,
	env: NodeJS.ProcessEnv = process.env,
) {
	const { scope, job, memberId, tediId } = InputSchema.parse(value);
	if (
		job.adapter !== "instinct-email" ||
		job.organizationId !== scope.organizationId ||
		job.workItemId !== scope.workItemId ||
		job.attemptId !== scope.attemptId ||
		job.senderUserId !== scope.senderUserId
	)
		throw new Error("Job does not match the held Instinct Work scope");
	const evidence = workRemoteJobEvidence(scope, read, env);
	const selectors = [
		"-w",
		scope.workspace,
		"--organization",
		scope.organization,
	];
	const options = { cwd: homedir(), env: { ...env } };
	async function call(callable: string, input: unknown) {
		return read(
			[
				...selectors,
				"code",
				`async () => await ${callable}(${codeModeLiteral(input)})`,
				"--json",
			],
			60_000,
			undefined,
			options,
		);
	}
	await evidence.verifyAttempt();
	const work = z
		.object({
			workItem: z.object({
				id: z.uuid(),
				orgId: z.uuid(),
				disposition: z.literal("accepted"),
				accountableOwnerType: z.literal("user"),
				accountableOwnerId: z.string(),
			}),
		})
		.parse(
			await read(
				[
					...selectors,
					"work",
					"dispatch-get",
					"--input",
					JSON.stringify({ id: scope.workItemId }),
					"--json",
				],
				60_000,
				undefined,
				options,
			),
		).workItem;
	if (
		work.id !== job.workItemId ||
		work.orgId !== job.organizationId ||
		work.accountableOwnerId !== job.senderUserId
	)
		throw new Error("Human sender does not match the accountable Work owner");
	const member = z
		.object({
			data: z.object({
				id: z.uuid(),
				organizationId: z.uuid(),
				email: z.email(),
				status: z.literal("active"),
				kind: z.literal("external_agent"),
				representedUserId: z.string(),
			}),
		})
		.parse(
			await call("members.get_member", {
				organizationId: scope.organizationId,
				memberId,
			}),
		).data;
	if (
		member.id !== memberId ||
		member.organizationId !== job.organizationId ||
		member.email !== job.recipient ||
		member.representedUserId !== job.senderUserId
	)
		throw new Error("Test mailbox is not the represented organization member");
	// Verify the scoped receive route before creating an outbound intent.
	z.object({
		threads: z.array(z.unknown()),
		nextCursor: z.string().nullable(),
	}).parse(
		await call("tedis.list_tedi_email_inbox", {
			tediId,
			query: `Tedix controlled job ${job.jobId}`,
			limit: 1,
		}),
	);
	const store = fileRemoteJobStore(
		join(env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), "remote-jobs"),
	);
	let received: z.infer<typeof ThreadSchema> | undefined;
	const proof = (threadId: string, messageId: string) =>
		`tedix://organizations/${scope.organizationId}/tedis/${tediId}/email/threads/${threadId}/messages/${messageId}`;
	const transport = createInstinctEmailTransport(
		{
			organizationId: scope.organizationId,
			memberId,
			memberEmail: member.email,
			testMailbox: job.recipient,
		},
		{
			async send(message) {
				await evidence.verifyAttempt();
				const sent = z
					.object({
						ok: z.literal(true),
						sent: z.literal(true),
						provider: z.literal("cloudflare"),
						messageId: z.string().min(1),
						emailMessageId: z.uuid(),
						threadId: z.uuid(),
					})
					.parse(
						await call("tedis.send_email", {
							tediId,
							to: [{ email: message.to }],
							subject: message.subject,
							text: JSON.stringify({
								...JSON.parse(message.body),
								replyProtocol:
									"Reply twice in this email thread: first a heartbeat, then a result. Each reply must contain only a JSON object copying organizationId, workItemId, attemptId, jobId, senderUserId and adapter from job. Add kind: heartbeat for the first reply. For the second add kind: result, outcome: succeeded or failed, and result: a short description of what happened. Do not perform sign-in, consent, purchases, or send any other messages. This is a controlled transport test.",
							}),
						}),
					);
				return {
					messageId: sent.emailMessageId,
					threadId: sent.threadId,
					proofRef: proof(sent.threadId, sent.emailMessageId),
				};
			},
			async read(messageId) {
				const message = received?.messages.find((row) => row.id === messageId);
				if (
					!received ||
					!message ||
					message.direction !== "inbound" ||
					!message.receivedAt ||
					!message.textBody
				)
					throw new Error("Missing inbound message body or provider timestamp");
				return {
					messageId,
					from: message.fromAddr,
					threadId: message.threadId,
					receivedAt: message.receivedAt,
					body: message.textBody,
					// The ingress requires aligned DKIM/DMARC even for organization members.
					senderVerified: received.thread.senderTrust === "trusted",
					proofRef: proof(message.threadId, message.id),
				};
			},
		},
	);
	const adapter = createInstinctEmailAdapter(
		store,
		{ status: "available", transport, testMailbox: job.recipient },
		evidence,
	);
	if (operation === "send") return adapter.sendJob(job);
	const prior = store.read(job);
	if (!prior?.receipt || JSON.stringify(prior.job) !== JSON.stringify(job))
		throw new Error("No matching confirmed job; reconciliation required");
	if (prior.publication?.status !== "published")
		throw new Error("Evidence publication uncertain; reconciliation required");
	if (prior.result) return prior;
	received = ThreadSchema.parse(
		await call("tedis.read_thread", {
			tediId,
			threadId: prior.receipt.providerJobId,
			markRead: false,
		}),
	);
	if (
		received.thread.id !== prior.receipt.providerJobId ||
		received.thread.tediId !== tediId ||
		received.thread.organizationId !== scope.organizationId ||
		received.messages.some(
			(message) =>
				message.threadId !== prior.receipt?.providerJobId ||
				message.tediId !== tediId ||
				message.organizationId !== scope.organizationId,
		)
	)
		throw new Error("Mailbox thread scope mismatch");
	let record = prior;
	for (const message of received.messages
		.filter((message) => message.direction === "inbound")
		.sort(
			(a, b) => Date.parse(a.receivedAt ?? "") - Date.parse(b.receivedAt ?? ""),
		)) {
		if (
			prior.heartbeat &&
			message.receivedAt &&
			Date.parse(message.receivedAt) < Date.parse(prior.heartbeat.observedAt)
		)
			continue;
		await evidence.verifyAttempt();
		record = await adapter.receiveResult(
			await transport.receiveResult(message.id),
		);
	}
	return record;
}

export async function runRemoteJobCommand(args: string[]) {
	if (args.includes("--help")) {
		console.log(
			"tedix lane remote-job send|receive --input <file> -w <workspace> --organization <org>",
		);
		return 0;
	}
	let operation: "send" | "receive" | undefined;
	let file: string | undefined,
		workspace: string | undefined,
		organization: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if ((arg === "send" || arg === "receive") && !operation) operation = arg;
		else if (arg === "--input") file = args[++index];
		else if (arg === "-w" || arg === "--workspace") workspace = args[++index];
		else if (arg === "--organization") organization = args[++index];
		else throw new Error(`Unknown remote-job argument: ${arg}`);
	}
	if (!operation || !file || !workspace || !organization)
		throw new Error(
			"Explicit operation, input file, workspace and organization are required",
		);
	const input = InputSchema.parse(JSON.parse(readFileSync(file, "utf8")));
	if (
		workspace !== input.scope.workspace ||
		organization !== input.scope.organization
	)
		throw new Error("Command selectors do not match the job scope");
	console.log(JSON.stringify(await runNativeRemoteJob(operation, input)));
	return 0;
}
