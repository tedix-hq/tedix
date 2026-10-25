import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { MAX_ACTIVE_DURABLE_TURNS } from "../../src/facet-turn-admission";
import type {
	TurnAdmissionFixture,
	TurnAdmissionParams,
} from "./turn-admission-fixture";

const bindings = env as unknown as {
	TURN_ADMISSION: DurableObjectNamespace<TurnAdmissionFixture>;
	TURN_ADMISSION_WORKFLOW: Workflow<TurnAdmissionParams>;
};

it("bounds concurrent async enqueues to one object and durably runs the rest later", async () => {
	const objectName = crypto.randomUUID();
	const agent = bindings.TURN_ADMISSION.getByName(objectName);
	const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
	const inspectors = await Promise.all(
		ids.map((id) =>
			introspectWorkflowInstance(bindings.TURN_ADMISSION_WORKFLOW, id),
		),
	);
	try {
		await Promise.all(
			inspectors.map((inspector) => inspector.modify((m) => m.disableSleeps())),
		);
		await Promise.all(
			ids.map((id) =>
				bindings.TURN_ADMISSION_WORKFLOW.create({
					id,
					params: { objectName, runId: id },
				}),
			),
		);
		await Promise.all(
			inspectors.map((inspector) =>
				inspector.waitForStepResult({ name: "mark-workflow-started" }),
			),
		);
		await expect
			.poll(async () => (await agent.inspect()).deferred, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(6);
		expect(await agent.inspect()).toMatchObject({
			active: 2,
			peak: 2,
			completed: [],
		});
		await agent.release();
		await Promise.all(
			inspectors.map((inspector) => inspector.waitForStatus("complete")),
		);
		const proof = await agent.inspect();
		expect(proof.active).toBe(0);
		expect(proof.peak).toBe(MAX_ACTIVE_DURABLE_TURNS);
		expect(proof.completed.sort()).toEqual(ids.sort());
	} finally {
		await agent.release();
		await Promise.all(inspectors.map((inspector) => inspector.dispose()));
	}
});

it("does not self-deadlock saturated parents against their own child enqueues", async () => {
	const agent = bindings.TURN_ADMISSION.getByName(crypto.randomUUID());
	const parents = [
		agent.turn("parent-1", "nested"),
		agent.turn("parent-2", "nested"),
	];
	await expect.poll(async () => (await agent.inspect()).active).toBe(2);
	await agent.release();
	// Both parent turns stay active until their child admissions return.
	await expect(Promise.all(parents)).resolves.toMatchObject([
		{ text: "done" },
		{ text: "done" },
	]);
	expect((await agent.inspect()).deferred).toBe(8);
	expect((await agent.inspect()).inlineChildren).toBe(2);
	for (let i = 0; i < 4; i++)
		await expect(agent.turn(`parent-1-child-${i}`)).resolves.toMatchObject({
			text: "done",
		});
	expect((await agent.inspect()).peak).toBe(2);
});

it("releases a failed turn slot and does not serialize independent objects", async () => {
	const agent = bindings.TURN_ADMISSION.getByName(crypto.randomUUID());
	const other = bindings.TURN_ADMISSION.getByName(crypto.randomUUID());
	const held = [agent.turn("held-1"), agent.turn("held-2")];
	await expect.poll(async () => (await agent.inspect()).active).toBe(2);
	await other.release();
	await expect(other.turn("independent")).resolves.toMatchObject({
		text: "done",
	});
	await agent.release();
	await Promise.all(held);
	expect(await agent.failureProbe()).toBe("scripted turn failure");
	await expect(agent.turn("after-failure")).resolves.toMatchObject({
		text: "done",
	});
	expect((await agent.inspect()).active).toBe(0);
});
