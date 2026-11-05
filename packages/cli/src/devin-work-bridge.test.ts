import { expect, test } from "bun:test";
import {
	createDevinWorkBridge,
	type DevinWorkBinding,
} from "./devin-work-bridge";

const binding: DevinWorkBinding = {
	orgId: "11111111-1111-4111-8111-111111111111",
	workItemId: "22222222-2222-4222-8222-222222222222",
	workVersion: 2,
	attemptId: "33333333-3333-4333-8333-333333333333",
	executorId: "44444444-4444-4444-8444-444444444444",
	externalSessionKey: "devin:quiet-river",
};
function fixture() {
	const workItem = {
		id: binding.workItemId,
		orgId: binding.orgId,
		version: binding.workVersion,
		disposition: "accepted",
		title: "Read the widget",
		description: "Inspect its result.",
		projectId: "55555555-5555-4555-8555-555555555555",
		acceptanceContract: { version: 1, doneLooksLike: "Widget inspected." },
		metadata: { hostOnly: "not for the sandbox" },
	};
	const attempt = {
		id: binding.attemptId,
		orgId: binding.orgId,
		workItemId: binding.workItemId,
		executorType: "external_agent",
		executorId: binding.executorId,
		externalSessionKey: binding.externalSessionKey,
		runtimeState: "running",
		outcome: null as string | null,
		expiresAt: new Date(Date.now() + 300000).toISOString(),
		metadata: {
			dispatchVersion: binding.workVersion,
			hostOnly: "not for the sandbox",
		},
	};
	const comments: Record<string, unknown>[] = [];
	let reads = 0,
		writes = 0;
	const host = {
		async read() {
			reads++;
			return { workItem, attempt, comments };
		},
		async post(note: string) {
			writes++;
			const comment = {
				id: "saved-note",
				orgId: binding.orgId,
				workItemId: binding.workItemId,
				authorType: "external_agent",
				authorId: binding.executorId,
				body: note,
				metadata: { agentSession: binding.externalSessionKey },
				createdAt: new Date().toISOString(),
			};
			comments.push(comment);
			return comment;
		},
	};
	const bridge = createDevinWorkBridge(binding, host);
	const result = (scope = binding, outcome = "succeeded") =>
		`TEDIX_WORK_RESULT ${JSON.stringify({ binding: scope, outcome, note: "Widget inspected.\nEvidence: https://example.invalid/proof" })}`;
	return {
		bridge,
		host,
		workItem,
		attempt,
		comments,
		result,
		counts: () => ({ reads, writes }),
	};
}

test("supplies only admitted context and verifies the exact saved note once", async () => {
	const f = fixture();
	const context = await f.bridge.context();
	expect(context.work.title).toBe("Read the widget");
	expect(JSON.stringify(context)).not.toContain("hostOnly");
	expect(JSON.stringify(context)).not.toContain("comments");
	const saved = await f.bridge.deliver(f.result());
	expect(saved.body).toContain("Widget inspected.");
	expect(saved.sha256).toHaveLength(64);
	const confirmation = `TEDIX_WORK_VERIFIED ${JSON.stringify({ binding, commentId: saved.commentId, sha256: saved.sha256 })}`;
	expect(await f.bridge.verify(confirmation)).toMatchObject({
		outcome: "succeeded",
		note: saved.body,
	});
	await expect(f.bridge.deliver(f.result())).rejects.toThrow(
		"already attempted",
	);
	await expect(f.bridge.verify(confirmation)).rejects.toThrow("exact result");
	expect(f.counts().writes).toBe(1);
});

test.each([
	["workItemId", "66666666-6666-4666-8666-666666666666"],
	["orgId", "66666666-6666-4666-8666-666666666666"],
	["attemptId", "66666666-6666-4666-8666-666666666666"],
	["externalSessionKey", "devin:other-session"],
	["executorId", "other-executor"],
	["workVersion", 3],
] as const)("denies another %s before a host operation", async (key, value) => {
	const f = fixture();
	await f.bridge.context();
	await expect(
		f.bridge.deliver(f.result({ ...binding, [key]: value })),
	).rejects.toThrow("scope denied");
	expect(f.counts()).toEqual({ reads: 1, writes: 0 });
});

test.each([
	'{"binding":{},"outcome":"succeeded","note":"hello"}',
	JSON.stringify({
		binding,
		outcome: "succeeded",
		note: "hello",
		command: "work list",
	}),
	JSON.stringify({ binding, outcome: "succeeded", note: "x".repeat(10001) }),
])("rejects an unbounded or tool-selecting envelope", async (json) => {
	const f = fixture();
	await f.bridge.context();
	await expect(f.bridge.deliver(`TEDIX_WORK_RESULT ${json}`)).rejects.toThrow();
	expect(f.counts()).toEqual({ reads: 1, writes: 0 });
});

test.each([
	"work",
	"org",
	"version",
	"attempt",
	"session",
	"expiry",
	"outcome",
	"contract",
	"state",
])("revoked %s denies delivery without a write", async (change) => {
	const f = fixture();
	await f.bridge.context();
	if (change === "work") f.workItem.id = "66666666-6666-4666-8666-666666666666";
	if (change === "org")
		f.attempt.orgId = "66666666-6666-4666-8666-666666666666";
	if (change === "version") f.workItem.version++;
	if (change === "attempt")
		f.attempt.id = "66666666-6666-4666-8666-666666666666";
	if (change === "session")
		f.attempt.externalSessionKey = "devin:other-session";
	if (change === "expiry") f.attempt.expiresAt = new Date(0).toISOString();
	if (change === "outcome") f.attempt.outcome = "cancelled";
	if (change === "contract")
		f.workItem.acceptanceContract.doneLooksLike = "Changed contract";
	if (change === "state") f.workItem.disposition = "completed";
	await expect(f.bridge.deliver(f.result())).rejects.toThrow(
		"no longer current",
	);
	expect(f.counts().writes).toBe(0);
});

test("missing context, duplicate envelopes and trailing text cannot deliver", async () => {
	const f = fixture();
	await expect(f.bridge.deliver(f.result())).rejects.toThrow("not admitted");
	await f.bridge.context();
	for (const message of [
		`${f.result()}\n${f.result()}`,
		`${f.result()}\nMore text.`,
		`${f.result()}\nTEDIX_LANE_RESULT ${JSON.stringify({ workItemId: binding.workItemId, workVersion: 2, contractVersion: 1, outcomeText: "Widget inspected.", outcome: "completed" })}`,
		"No result",
	])
		await expect(f.bridge.deliver(message)).rejects.toThrow("one final");
	expect(f.counts().writes).toBe(0);
});

test("a failed report can be read back but never becomes succeeded", async () => {
	const f = fixture();
	await f.bridge.context();
	const saved = await f.bridge.deliver(f.result(binding, "failed"));
	expect(
		(
			await f.bridge.verify(
				`TEDIX_WORK_VERIFIED ${JSON.stringify({ binding, commentId: saved.commentId, sha256: saved.sha256 })}`,
			)
		).outcome,
	).toBe("failed");
});

test("uncertain writes and concurrent delivery are never replayed", async () => {
	const f = fixture();
	let writes = 0;
	f.host.post = async () => {
		writes++;
		throw new Error("response lost");
	};
	await f.bridge.context();
	const results = await Promise.allSettled([
		f.bridge.deliver(f.result()),
		f.bridge.deliver(f.result()),
	]);
	expect(results.every((result) => result.status === "rejected")).toBe(true);
	await expect(f.bridge.deliver(f.result())).rejects.toThrow(
		"already attempted",
	);
	expect(writes).toBe(1);
});

test.each(["missing", "body", "session", "author", "org", "work"])(
	"a %s readback fails after one write",
	async (change) => {
		const f = fixture();
		const post = f.host.post;
		f.host.post = async (note) => {
			const receipt = await post(note);
			const saved = f.comments[0]!;
			if (change === "missing") f.comments.length = 0;
			if (change === "body") saved.body = "different";
			if (change === "session")
				saved.metadata = { agentSession: "devin:other-session" };
			if (change === "author") saved.authorId = "other-executor";
			if (change === "org")
				saved.orgId = "66666666-6666-4666-8666-666666666666";
			if (change === "work")
				saved.workItemId = "66666666-6666-4666-8666-666666666666";
			return {
				...receipt,
				body: note,
				metadata: { agentSession: binding.externalSessionKey },
				authorId: binding.executorId,
				orgId: binding.orgId,
				workItemId: binding.workItemId,
			};
		};
		await f.bridge.context();
		await expect(f.bridge.deliver(f.result())).rejects.toThrow();
		expect(f.counts().writes).toBe(1);
	},
);

test("verification cannot change scope, acknowledge a different result or outlive admission", async () => {
	const f = fixture();
	await f.bridge.context();
	const saved = await f.bridge.deliver(f.result());
	const confirmation = {
		binding,
		commentId: saved.commentId,
		sha256: saved.sha256,
	};
	await expect(
		f.bridge.verify(
			`TEDIX_WORK_VERIFIED ${JSON.stringify({ ...confirmation, binding: { ...binding, externalSessionKey: "devin:other-session" } })}`,
		),
	).rejects.toThrow("scope denied");
	await expect(
		f.bridge.verify(
			`TEDIX_WORK_VERIFIED ${JSON.stringify({ ...confirmation, commentId: "other" })}`,
		),
	).rejects.toThrow("exact result");
	f.attempt.expiresAt = new Date(0).toISOString();
	await expect(
		f.bridge.verify(`TEDIX_WORK_VERIFIED ${JSON.stringify(confirmation)}`),
	).rejects.toThrow("no longer current");
});
