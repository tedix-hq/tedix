import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { DurableCodeRecoveryFixture } from "./pi-runtime/durable-codemode-recovery-fixture";
import { DURABLE_CODE_RECOVERY_MESSAGE } from "../src/durable-codemode-recovery";
const bindings = env as unknown as {
	DURABLE_CODE_RECOVERY: DurableObjectNamespace<DurableCodeRecoveryFixture>;
};
const open = () =>
	bindings.DURABLE_CODE_RECOVERY.getByName(crypto.randomUUID());
it("recovers native stale journal preserving unknown effects and late callbacks", async () => {
	const name = crypto.randomUUID();
	let host = bindings.DURABLE_CODE_RECOVERY.getByName(name);
	const row = await host.seedUnknownEffect();
	const paused = await host.seed("paused");
	await abortAllDurableObjects();
	host = bindings.DURABLE_CODE_RECOVERY.getByName(name);
	expect(await host.read(row.id)).toEqual(row);
	const input = { executionId: row.id, expectedUpdatedAt: row.updatedAt };
	expect(await host.recover(input, row.updatedAt + 314999)).toMatchObject({
		recovered: false,
		reason: "too_recent",
	});
	expect(
		await host.recover(
			{ ...input, expectedUpdatedAt: row.updatedAt - 1 },
			row.updatedAt + 315000,
		),
	).toMatchObject({ recovered: false, reason: "revision_changed" });
	expect(await host.recover(input, row.updatedAt + 315000)).toMatchObject({
		recovered: true,
		execution_status: "error",
		completion: "unconfirmed",
		effects_may_have_occurred: true,
	});
	const recovered = await host.read(row.id);
	expect(recovered?.logJson).toEqual(row.logJson);
	expect(recovered?.code).toBe(row.code);
	expect(recovered?.error).toBe(DURABLE_CODE_RECOVERY_MESSAGE);
	await host.lateComplete(row.id);
	await host.lateFail(row.id);
	expect(await host.read(row.id)).toEqual(recovered);
	await host.markRolledBack(row.id);
	const rolled = await host.read(row.id);
	await host.lateComplete(row.id);
	await host.lateFail(row.id);
	expect(await host.read(row.id)).toEqual(rolled);
	expect(await host.read(paused.id)).toEqual(paused);
	expect(await host.recover(input, row.updatedAt + 400000)).toMatchObject({
		recovered: false,
		reason: "not_running",
	});
});
it("leaves completed and paused records untouched", async () => {
	const host = open();
	for (const status of ["paused", "completed"] as const) {
		const row = await host.seed(status);
		expect(
			await host.recover(
				{ executionId: row.id, expectedUpdatedAt: row.updatedAt },
				row.updatedAt + 400000,
			),
		).toMatchObject({ recovered: false, reason: "not_running" });
		expect(await host.read(row.id)).toEqual(row);
	}
	expect(
		await host.recover(
			{ executionId: "missing", expectedUpdatedAt: 0 },
			400000,
		),
	).toMatchObject({ reason: "execution_not_found" });
});
it("denies active-pass recovery and new passes racing recovery", async () => {
	const host = open();
	const row = await host.seed();
	const input = { executionId: row.id, expectedUpdatedAt: row.updatedAt };
	const pass = host.holdPass();
	expect(await host.recover(input, row.updatedAt + 400000)).toMatchObject({
		reason: "active_pass",
	});
	await host.releaseHeldPass();
	await pass;
	const recovery = host.holdRecovery(input);
	expect(await host.newPass()).toMatchObject({
		ok: false,
		error: expect.stringContaining("recovery is in progress"),
	});
	await host.releaseHeldRecovery();
	await recovery;
	expect(await host.newPass()).toEqual({ ok: true });
});

it("fences the native facet by workspace and execution identity", async () => {
	const host = open();
	const own = await host.seed();
	const other = await host.seedOtherFacet();
	expect(await host.readOtherFacet(own.id)).toBeNull();
	expect(await host.read(other.id)).toBeNull();
	expect(
		await host.recover(
			{ executionId: other.id, expectedUpdatedAt: other.updatedAt },
			other.updatedAt + 400000,
		),
	).toMatchObject({ recovered: false, reason: "execution_not_found" });
	expect(await host.readOtherFacet(other.id)).toEqual(other);
	expect(await host.read(own.id)).toEqual(own);
});
