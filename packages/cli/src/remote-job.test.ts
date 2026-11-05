import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createInstinctEmailAdapter,
	createRemoteJobAdapter,
	remoteAdapterOrder,
	type RemoteJob,
	type RemoteJobEvent,
} from "./remote-job";
import { fileRemoteJobStore } from "./remote-job-store";
import { createInstinctEmailTransport } from "./remote-job-email";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "remote-job-test-"));
	directories.push(directory);
	const job: RemoteJob = {
		organizationId: "11111111-1111-4111-8111-111111111111",
		workItemId: "22222222-2222-4222-8222-222222222222",
		attemptId: "33333333-3333-4333-8333-333333333333",
		jobId: "44444444-4444-4444-8444-444444444444",
		senderUserId: "fictional-human",
		adapter: "instinct-email",
		recipient: "test@example.test",
		brief: "Return a controlled test result",
	};
	let sends = 0;
	const connection = {
		status: "available" as const,
		testMailbox: job.recipient,
		transport: {
			async sendJob() {
				sends++;
				return { providerJobId: "thread-1", proofRef: "test://sent-message-1" };
			},
		},
	};
	const store = fileRemoteJobStore(directory);
	return {
		directory,
		job,
		connection,
		store,
		sends: () => sends,
		adapter: createInstinctEmailAdapter(store, connection),
	};
}
function event(job: RemoteJob): Extract<RemoteJobEvent, { kind: "result" }> {
	const { recipient: _, brief: __, ...correlation } = job;
	return {
		...correlation,
		kind: "result",
		eventId: "message-2",
		providerJobId: "thread-1",
		observedAt: "2026-10-01T12:00:00.000Z",
		outcome: "succeeded",
		result: "Controlled reply",
		proofRef: "test://reply-2",
	};
}

describe("remote job adapters", () => {
	it("persists sender, job, heartbeat, result and proof across process reconstruction", async () => {
		const f = fixture();
		await f.adapter.sendJob(f.job);
		const result = event(f.job);
		const { outcome: _, result: __, ...heartbeat } = result;
		f.adapter.receiveResult({
			...heartbeat,
			kind: "heartbeat",
			eventId: "heartbeat-1",
		});
		const resumed = createInstinctEmailAdapter(
			fileRemoteJobStore(f.directory),
			f.connection,
		);
		expect(resumed.receiveResult(result)).toMatchObject({
			state: "succeeded",
			job: f.job,
			receipt: { proofRef: "test://sent-message-1" },
			heartbeat: { eventId: "heartbeat-1" },
			result,
		});
		expect(await resumed.sendJob(f.job)).toMatchObject({ state: "succeeded" });
		expect(f.sends()).toBe(1);
	});
	it("holds a timeout after provider delivery without replay", async () => {
		const f = fixture();
		let delivered = 0;
		const connection = {
			...f.connection,
			transport: {
				async sendJob(): Promise<never> {
					delivered++;
					throw new Error("timeout after send");
				},
			},
		};
		expect(
			await createInstinctEmailAdapter(f.store, connection).sendJob(f.job),
		).toMatchObject({ state: "unknown" });
		expect(
			await createInstinctEmailAdapter(
				fileRemoteJobStore(f.directory),
				connection,
			).sendJob(f.job),
		).toMatchObject({ state: "unknown" });
		expect(delivered).toBe(1);
		expect(() => f.adapter.receiveResult(event(f.job))).toThrow(
			"reconciliation",
		);
	});
	it("does not dispatch twice during concurrent send calls", async () => {
		const f = fixture();
		await Promise.all([f.adapter.sendJob(f.job), f.adapter.sendJob(f.job)]);
		expect(f.sends()).toBe(1);
	});
	it("refuses changed payloads and correlation or provider mismatches", async () => {
		const f = fixture();
		await f.adapter.sendJob(f.job);
		await expect(
			f.adapter.sendJob({ ...f.job, brief: "changed" }),
		).rejects.toThrow("changed");
		for (const field of [
			"senderUserId",
			"workItemId",
			"attemptId",
			"providerJobId",
		] as const) {
			const wrong =
				field.endsWith("Id") &&
				field !== "senderUserId" &&
				field !== "providerJobId"
					? "55555555-5555-4555-8555-555555555555"
					: "wrong";
			expect(() =>
				f.adapter.receiveResult({ ...event(f.job), [field]: wrong }),
			).toThrow("mismatch");
		}
	});
	it("deduplicates identical results and rejects conflicting terminal results", async () => {
		const f = fixture();
		await f.adapter.sendJob(f.job);
		const first = f.adapter.receiveResult(event(f.job));
		expect(f.adapter.receiveResult(event(f.job))).toEqual(first);
		expect(() =>
			f.adapter.receiveResult({ ...event(f.job), proofRef: "test://changed" }),
		).toThrow("Conflicting");
		expect(() =>
			f.adapter.receiveResult({ ...event(f.job), eventId: "message-3" }),
		).toThrow("terminal");
	});
	it("rejects a missing proof and non-test recipients before sending", async () => {
		const f = fixture();
		await expect(
			f.adapter.sendJob({ ...f.job, recipient: "outside@example.test" }),
		).rejects.toThrow("test mailbox");
		expect(f.sends()).toBe(0);
		await f.adapter.sendJob(f.job);
		expect(() =>
			f.adapter.receiveResult({ ...event(f.job), proofRef: "" }),
		).toThrow();
	});
	it("retains a crashed send intent and fails closed on an interrupted store lock", async () => {
		const f = fixture();
		await f.adapter.sendJob(f.job);
		const name = readdirSync(f.directory).find((name) =>
			name.endsWith(".json"),
		)!;
		writeFileSync(join(f.directory, `${name}.lock`), "interrupted writer");
		expect(() => f.adapter.receiveResult(event(f.job))).toThrow();
		expect(f.store.read(f.job)?.state).toBe("sent");
	});
	it("shows unconfigured cloud adapters as unavailable in the requested order", async () => {
		const f = fixture();
		expect(remoteAdapterOrder).toEqual([
			"instinct-email",
			"claude-cloud",
			"devin-cloud",
			"codex-cloud",
		]);
		for (const id of remoteAdapterOrder.slice(1)) {
			const adapter = createRemoteJobAdapter(id, f.store, {
				status: "unavailable",
				reason: "Connection not verified; owner sign-in may be required",
			});
			expect(adapter.availability.status).toBe("unavailable");
			await expect(adapter.sendJob({ ...f.job, adapter: id })).rejects.toThrow(
				"Unavailable",
			);
		}
		expect(f.sends()).toBe(0);
	});
});

it("runs the email envelope through authenticated provider reads and persistent correlation", async () => {
	const f = fixture();
	let sentBody = "";
	let senderVerified = true;
	let from = f.job.recipient;
	const transport = createInstinctEmailTransport(
		{
			organizationId: f.job.organizationId,
			memberId: "fictional-member",
			memberEmail: f.job.recipient,
			testMailbox: f.job.recipient,
		},
		{
			async send(message) {
				sentBody = message.body;
				expect(message.to).toBe(f.job.recipient);
				return {
					messageId: "message-1",
					threadId: "thread-1",
					proofRef: "test://send",
				};
			},
			async read() {
				return {
					messageId: "message-2",
					receivedAt: "2026-10-01T12:00:00.000Z",
					from,
					senderVerified,
					threadId: "thread-1",
					body: JSON.stringify({
						...event(f.job),
						providerJobId: "untrusted-thread",
						eventId: "untrusted-id",
						observedAt: "2026-01-01T00:00:00.000Z",
					}),
					proofRef: "test://provider-read",
				};
			},
		},
	);
	const adapter = createInstinctEmailAdapter(f.store, {
		...f.connection,
		transport,
	});
	await adapter.sendJob(f.job);
	expect(JSON.parse(sentBody).job).toEqual(f.job);
	from = "attacker@example.test";
	await expect(transport.receiveResult("message-2")).rejects.toThrow(
		"Unverified",
	);
	from = f.job.recipient;
	senderVerified = false;
	await expect(transport.receiveResult("message-2")).rejects.toThrow(
		"Unverified",
	);
	senderVerified = true;
	await expect(transport.receiveResult("wrong-id")).rejects.toThrow(
		"correlation",
	);
	expect(
		adapter.receiveResult(await transport.receiveResult("message-2")),
	).toMatchObject({
		state: "succeeded",
		result: {
			proofRef: "test://provider-read",
			providerJobId: "thread-1",
			eventId: "message-2",
			observedAt: "2026-10-01T12:00:00.000Z",
		},
	});
});

it("requires the test mailbox to be the configured organization member email", async () => {
	const f = fixture();
	let sends = 0;
	const transport = createInstinctEmailTransport(
		{
			organizationId: f.job.organizationId,
			memberId: "fictional-member",
			memberEmail: "member@example.test",
			testMailbox: f.job.recipient,
		},
		{
			async send() {
				sends++;
				throw new Error("must not send");
			},
			async read(): Promise<never> {
				throw new Error("must not read");
			},
		},
	);
	await expect(transport.sendJob(f.job)).rejects.toThrow("member test mailbox");
	expect(sends).toBe(0);
});

it("retains send intent after a process dies inside the provider call", async () => {
	const f = fixture();
	const { spawnSync } = await import("node:child_process");
	const child = spawnSync(
		process.execPath,
		[
			"--eval",
			`
		import { createInstinctEmailAdapter } from ${JSON.stringify(new URL("./remote-job.ts", import.meta.url).pathname)};
		import { fileRemoteJobStore } from ${JSON.stringify(new URL("./remote-job-store.ts", import.meta.url).pathname)};
		const adapter = createInstinctEmailAdapter(fileRemoteJobStore(${JSON.stringify(f.directory)}), {
			status: "available", testMailbox: ${JSON.stringify(f.job.recipient)},
			transport: { async sendJob() { process.exit(0); } }
		});
		await adapter.sendJob(${JSON.stringify(f.job)});
	`,
		],
		{ cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" },
	);
	expect(child.status).toBe(0);
	expect(await f.adapter.sendJob(f.job)).toMatchObject({ state: "sending" });
	expect(f.sends()).toBe(0);
});

it("compares heartbeat times chronologically across fractional precision", async () => {
	const f = fixture();
	await f.adapter.sendJob(f.job);
	const { outcome: _, result: __, ...base } = event(f.job);
	f.adapter.receiveResult({
		...base,
		kind: "heartbeat",
		eventId: "hb-1",
		observedAt: "2026-10-01T12:00:00Z",
	});
	f.adapter.receiveResult({
		...base,
		kind: "heartbeat",
		eventId: "hb-2",
		observedAt: "2026-10-01T12:00:00.001Z",
	});
	expect(() =>
		f.adapter.receiveResult({
			...base,
			kind: "heartbeat",
			eventId: "hb-old",
			observedAt: "2026-10-01T12:00:00Z",
		}),
	).toThrow("Stale");
});
