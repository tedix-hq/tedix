import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { ComputerTurnFixture } from "./pi-runtime/computer-turn-fixture";

const bindings = env as unknown as {
	COMPUTER_TURN: DurableObjectNamespace<ComputerTurnFixture>;
};

it("executes native Pi against the resolved conversation Computer surface", async () => {
	const fixture = await getAgentByName(
		bindings.COMPUTER_TURN,
		crypto.randomUUID(),
	);
	const result = await fixture.run();
	expect(result.text).toBe("completed");
	expect(result.conversationFile).toBe("written in conversation");
	expect(result.operatorFile).toBeNull();
	const names = result.seenTools.map((tool) => tool.name);
	for (const name of [
		"read",
		"ls",
		"find",
		"grep",
		"write",
		"edit",
		"delete",
		"exec",
	])
		expect(names).toContain(name);
	expect(names).not.toContain("list");
	expect(names).not.toContain("bash");
	expect(
		result.seenTools.find((tool) => tool.name === "find")?.description,
	).toBe(result.expectedFindDescription);
}, 30_000);

it.each([false, true])(
	"preserves detached ownership with changed ambient state (%s) across reset",
	async (replaceAmbient) => {
		const name = crypto.randomUUID();
		const fixture = await getAgentByName(bindings.COMPUTER_TURN, name);
		const detached = await fixture.detachOwningSession(replaceAmbient);
		expect(detached.result.error).toBeUndefined();
		expect(detached.result).toMatchObject({
			status: "running",
			executionId: detached.wake?.executionId,
		});
		expect(detached.starts).toBe(1);
		expect(detached.wake).toMatchObject({
			sessionKey: "detached-owner-session",
			workItemId: "detached-owner-work",
			launchedByRunId: "detached-owner-run",
			homeRunId: "detached-owner-home",
		});
		await abortAllDurableObjects();
		const restarted = await getAgentByName(bindings.COMPUTER_TURN, name);
		expect(await restarted.inspectDetachedOwner()).toEqual({
			starts: 1,
			wake: detached.wake,
		});
		const sameCall = await restarted.detachOwningSession(replaceAmbient);
		expect(sameCall.result).toMatchObject({
			executionId: detached.wake?.executionId,
		});
		expect(sameCall.starts).toBe(1);
		expect(sameCall.wake).toEqual(detached.wake);
	},
);

it("retains one native refresh across foreground observation and DO recovery", async () => {
	const name = crypto.randomUUID();
	const fixture = await getAgentByName(bindings.COMPUTER_TURN, name);
	expect((await fixture.observeNativeRefresh()).result.ready).toBe(false);
	await expect
		.poll(async () => (await fixture.observeNativeRefresh()).calls)
		.toBe(1);
	expect((await fixture.observeNativeRefresh()).result.ready).toBe(false);
	await abortAllDurableObjects();
	const recovered = await getAgentByName(bindings.COMPUTER_TURN, name);
	await expect
		.poll(async () => (await recovered.observeNativeRefresh()).result.ready)
		.toBe(true);
	const final = await recovered.observeNativeRefresh();
	expect(final.calls).toBe(2); // reconciliation resumes; no command execution is dispatched
	expect(final.result.ready).toBe(true);
}, 30_000);
