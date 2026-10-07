import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vite-plus/test";
import { RuntimeAdmission } from "../../src/runtime-admission";
import {
	InertRuntimeDO,
	requiresInertReceiver,
} from "../../src/inert-runtime-do";
import type { PiRuntimeFixture } from "./worker";

function fixture() {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	return ns.get(ns.idFromName(crypto.randomUUID()));
}

function quarantine(state: DurableObjectState) {
	const owner = {
		tediId: "fixture-tedi",
		orgId: "fixture-org",
		objectId: state.id.toString(),
	};
	new RuntimeAdmission(state.storage, owner, () => ({
		owner,
		digest: "a".repeat(64),
		complete: true,
		unknown: 0,
		nonterminal: 0,
	})).initialize({
		operationId: "fixture-quarantine",
		state: "quarantined",
		reason: "fixture",
	});
}

function seal(state: DurableObjectState) {
	state.storage.sql.exec(
		"CREATE TABLE historical_replay_seals(identity TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,link_hash TEXT NOT NULL)",
	);
	state.storage.sql.exec(
		"INSERT INTO historical_replay_seals VALUES ('run:fixture','snapshot','hash')",
	);
}

async function productionClasses() {
	const parentPath = "../../src/do";
	const facetPath = "../../src/conversation-facet";
	const { AgentTediDO } = (await import(/* @vite-ignore */ parentPath)) as {
		AgentTediDO: new (ctx: DurableObjectState, env: Cloudflare.Env) => object;
	};
	const { ConversationFacet } = (await import(
		/* @vite-ignore */ facetPath
	)) as {
		ConversationFacet: new (
			ctx: DurableObjectState,
			env: Cloudflare.Env,
		) => object;
	};
	return [AgentTediDO, ConversationFacet] as const;
}

async function expectInert(state: DurableObjectState) {
	for (const Production of await productionClasses()) {
		const receiver = new Production(state, env as Cloudflare.Env);
		expect(receiver).toBeInstanceOf(InertRuntimeDO);
		const inert = receiver as InertRuntimeDO;
		const response = await inert.fetch();
		expect(response.status).toBe(423);
		expect(await response.text()).toBe("runtime object is not admitted");
		await state.storage.setAlarm(Date.now() + 60_000);
		await inert.alarm();
		expect(await state.storage.getAlarm()).toBeNull();
	}
}

describe("inert runtime receiver", () => {
	it("admits an object with no stored admission and no seals", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			expect(requiresInertReceiver(state.storage, state.id.toString())).toBe(
				false,
			);
		});
	});

	it("boots the inert receiver for a non-active admission", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			quarantine(state);
			expect(requiresInertReceiver(state.storage, state.id.toString())).toBe(
				true,
			);
			await expectInert(state);
		});
	});

	it("boots the inert receiver when historical replay seals exist", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			state.storage.sql.exec(
				"CREATE TABLE historical_replay_seals(identity TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,link_hash TEXT NOT NULL)",
			);
			expect(requiresInertReceiver(state.storage, state.id.toString())).toBe(
				false,
			);
			state.storage.sql.exec("DROP TABLE historical_replay_seals");
			seal(state);
			expect(requiresInertReceiver(state.storage, state.id.toString())).toBe(
				true,
			);
			await expectInert(state);
		});
	});
});
