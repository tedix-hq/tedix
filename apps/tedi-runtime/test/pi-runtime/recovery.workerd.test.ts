import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { PiConversationFixture } from "./worker";

it("inspects a parked native tool without submitting or dispatching an effect", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<PiConversationFixture>;
		}
	).PI_CONVERSATION;
	const agent = await getAgentByName(namespace, crypto.randomUUID());
	await agent.setup("tool");
	const running = agent.turn("diagnostic-operation", { approval: true });
	let approval: { approvalId: string } | undefined;
	for (let attempt = 0; attempt < 60; attempt++) {
		const pending = await agent.pendingToolApprovals();
		if (pending.length) {
			approval = pending[0];
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(approval).toBeDefined();
	try {
		const before = JSON.parse(await agent.inspectFixture());
		const read = await agent.inspectRecovery(
			"fixture-session",
			"diagnostic-operation",
		);
		expect(read.operation?.operationId).toBe("diagnostic-operation");
		expect(read.operation?.status).toBe("placed");
		expect(read.taskCount).toBeGreaterThan(0);
		expect(
			read.tasks.some(
				(task) => task.kind.includes("approval") || task.view === "waiting",
			),
		).toBe(true);
		const after = JSON.parse(await agent.inspectFixture());
		expect(after.stats.requests).toBe(before.stats.requests);
		expect(after.stats.effects).toBe(0);
		expect(JSON.stringify(read)).not.toContain("Fixture system");
		await expect(
			(async () =>
				await agent.inspectRecovery(
					"fixture/session",
					"diagnostic-operation",
				))(),
		).rejects.toThrow("session_mismatch");
	} finally {
		if (approval)
			await agent.resolveToolApproval({
				approvalId: approval.approvalId,
				approved: false,
			});
		await running;
	}
});

it("reports an interrupted native operation after eviction without duplicating admission", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<PiConversationFixture>;
		}
	).PI_CONVERSATION;
	const name = crypto.randomUUID();
	const first = await getAgentByName(namespace, name);
	await first.setup("tool");
	const interrupted = first
		.turn("interrupted-diagnostic", { approval: true })
		.catch(() => undefined);
	let approval: { approvalId: string } | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		const pending = await first.pendingToolApprovals();
		if (pending[0]) {
			approval = pending[0];
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(approval).toBeDefined();
	const before = JSON.parse(await first.inspectFixture());
	await abortAllDurableObjects();
	await interrupted;
	const recovered = await getAgentByName(namespace, name);
	try {
		const view = await recovered.inspectRecovery(
			"fixture-session",
			"interrupted-diagnostic",
		);
		expect(view.operation?.status).toBe("placed");
		expect(view.taskCount).toBeGreaterThan(0);
		const after = JSON.parse(await recovered.inspectFixture());
		expect(after.stats.requests).toBe(before.stats.requests);
		expect(after.stats.effects).toBe(0);
	} finally {
		if (approval)
			await recovered.resolveToolApproval({
				approvalId: approval.approvalId,
				approved: false,
			});
		await recovered.turn("interrupted-diagnostic", { approval: true });
	}
});
