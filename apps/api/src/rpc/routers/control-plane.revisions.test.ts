import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { tediControlPlaneBindingHistory } from "@tedix/db/schema/control-plane-history";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "@tedix/db/schema/control-plane";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { controlPlaneContractRouter } from "./control-plane";

const runtime = vi.hoisted(() => ({
	invalidateConfig: vi.fn(),
	triggerCronSync: vi.fn(),
}));
vi.mock("@tedix/provisioning", async (original) => ({
	...(await original<typeof import("@tedix/provisioning")>()),
	...runtime,
}));

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			tediControlPlaneBindingHistory,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
	`);
	const env = {
		ENVIRONMENT: "test",
		DB: createD1Facade(sqlite),
	} as unknown as CloudflareEnv;
	const context = {
		authType: "user",
		db: createDbClient(env.DB),
		env,
		headers: new Headers(),
		organizationId: "org-1",
		userId: "user-1",
		url: new URL("https://api.tedix.test/rpc/control-plane"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
	return {
		client: createRouterClient(controlPlaneContractRouter, { context }),
		sqlite,
		context,
	};
}

describe("control-plane immutable revision API", () => {
	it("publishes, diffs, rolls back, and exposes exact binding history headlessly", async () => {
		const { client, sqlite } = setup();
		const initial = await client.createRuntimeProfile({
			name: "Default",
			slug: "default",
			config: { model: "a", nested: { enabled: true } },
		});
		expect(initial).toMatchObject({
			version: 1,
			changeSummary: "Initial revision",
			publishedBy: "user-1",
		});

		const second = await client.publishRuntimeProfileRevision({
			id: initial.id,
			expectedVersion: 1,
			changeSummary: "Use model b",
			config: { model: "b", nested: { enabled: true } },
		});
		expect(second).toMatchObject({
			version: 2,
			supersedesRevisionId: initial.id,
		});
		expect(
			(await client.listRuntimeProfileRevisions({ id: second.id })).data.map(
				(revision) => revision.version,
			),
		).toEqual([2, 1]);
		expect(
			await client.diffRuntimeProfileRevisions({
				id: initial.id,
				otherId: second.id,
			}),
		).toMatchObject({
			changes: [{ path: "$.model", kind: "changed", before: "a", after: "b" }],
		});

		sqlite.exec(`
			INSERT INTO tedis
				(id, organization_id, name, slug, runtime_profile_id)
			VALUES ('tedi-1', 'org-1', 'Tedi', 'tedi', '${second.id}');
		`);
		const rollback = await client.rollbackRuntimeProfileRevision({
			id: second.id,
			targetRevisionId: initial.id,
			tediId: "tedi-1",
			expectedVersion: 2,
			changeSummary: "Restore known-good model",
		});
		expect(rollback).toMatchObject({
			version: 3,
			rollbackOfRevisionId: initial.id,
			config: { model: "a" },
		});
		expect(
			await client.listTediControlPlaneBindingHistory({ tediId: "tedi-1" }),
		).toMatchObject({
			data: [
				{
					previousRevisionId: second.id,
					revisionId: rollback.id,
					kind: "runtime_profile",
				},
			],
		});
	});
});

const orgId = "10000000-0000-4000-8000-000000000001";
const tediId = "20000000-0000-4000-8000-000000000001";
const oldId = "30000000-0000-4000-8000-000000000001";
const newId = "30000000-0000-4000-8000-000000000002";
const activation = {
	organizationId: orgId,
	tediId,
	id: newId,
	expectedRevisionId: oldId,
	changeReason: "Repair cron messages",
};
const syncResult = {
	success: true,
	cronBootstrap: {
		ok: true,
		forceUpdate: false,
		templateCount: 0,
		existingCount: 0,
		plannedCount: 0,
		appliedCount: 0,
		actions: [],
		errors: [],
	},
};
function activationSetup() {
	const fixture = setup();
	fixture.context.user!.scope = "platform:admin";
	fixture.sqlite.exec(`
 INSERT INTO organizations (id,name,slug) VALUES ('${orgId}','Target','target');
 INSERT INTO policy_packs (id,name,slug,scope,target,status,version,published_at,definition)
 VALUES ('${oldId}','Old','default','system','tedi','active',1,'2026-01-01','{}'),
 ('${newId}','New','repaired','system','tedi','active',1,'2026-01-02','{"cronPolicy":{"disableCognitiveDefaults":true,"cronTemplates":[]}}');
 INSERT INTO tedis (id,organization_id,name,slug,policy_pack_id,runtime_overrides)
 VALUES ('${tediId}','${orgId}','Target','target','${oldId}','{"cronPolicy":{"disabledCognitiveCronNames":["brain-reflection"]}}');
 `);
	return fixture;
}
describe("policy revision activation", () => {
	beforeEach(() => {
		runtime.invalidateConfig.mockReset().mockResolvedValue(true);
		runtime.triggerCronSync.mockReset().mockResolvedValue(syncResult);
	});
	it("binds across families, audits once, and resumes reconciliation idempotently without changing overrides", async () => {
		const { client, sqlite } = activationSetup();
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			bindingApplied: true,
			reconciled: true,
			currentRevisionId: newId,
		});
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			reconciled: true,
		});
		expect(
			sqlite
				.prepare(
					"SELECT previous_revision_id,revision_id FROM tedi_control_plane_binding_history",
				)
				.all(),
		).toEqual([{ previous_revision_id: oldId, revision_id: newId }]);
		expect(runtime.triggerCronSync).toHaveBeenLastCalledWith(
			expect.anything(),
			{ forceUpdate: false },
		);
		expect(
			sqlite
				.prepare("SELECT runtime_overrides FROM tedis WHERE id=?")
				.get(tediId),
		).toEqual({
			runtime_overrides:
				'{"cronPolicy":{"disabledCognitiveCronNames":["brain-reflection"]}}',
		});
		expect(
			sqlite
				.prepare("SELECT definition FROM policy_packs WHERE id=?")
				.get(newId),
		).toEqual({
			definition:
				'{"cronPolicy":{"disableCognitiveDefaults":true,"cronTemplates":[]}}',
		});
	});
	it("reports a concurrent rebind during runtime reconciliation", async () => {
		const { client, sqlite } = activationSetup();
		runtime.triggerCronSync.mockImplementationOnce(async () => {
			sqlite
				.prepare("UPDATE tedis SET policy_pack_id=? WHERE id=?")
				.run(oldId, tediId);
			return syncResult;
		});
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			bindingApplied: true,
			reconciled: false,
			currentRevisionId: oldId,
		});
	});
	it("returns a sanitized partial result after readback failure and safely retries", async () => {
		const { client, context, sqlite } = activationSetup();
		runtime.triggerCronSync.mockImplementationOnce(async () => {
			vi.spyOn(context.db.query.tedis, "findFirst").mockRejectedValueOnce(
				new Error(
					"SELECT secret FROM https://internal.example X-Tedix-Host: private",
				),
			);
			return syncResult;
		});
		const result = await client.activatePolicyPackRevision(activation);
		expect(result).toMatchObject({
			bindingApplied: true,
			reconciled: false,
			currentRevisionId: null,
			error: "Policy binding applied; current policy pin could not be verified",
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			reconciled: true,
			currentRevisionId: newId,
		});
		expect(
			sqlite
				.prepare("SELECT count(*) n FROM tedi_control_plane_binding_history")
				.get(),
		).toEqual({ n: 1 });
	});
	it.each([
		{ authType: "user", marker: "externalAgentPrincipalId" },
		{ authType: "user", marker: "tediId" },
		{ authType: "apikey", marker: "externalAgentPrincipalId" },
		{ authType: "apikey", marker: "tediId" },
	] as const)(
		"rejects $authType transport with $marker actor provenance",
		async ({ authType, marker }) => {
			const { client, context, sqlite } = activationSetup();
			context.authType = authType;
			context.apiKey = {
				id: "operator",
				scopes: ["platform:admin"],
			} as BaseContext["apiKey"];
			context[marker] = "agent-principal";
			await expect(
				client.activatePolicyPackRevision(activation),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(runtime.triggerCronSync).not.toHaveBeenCalled();
			expect(
				sqlite
					.prepare("SELECT count(*) n FROM tedi_control_plane_binding_history")
					.get(),
			).toEqual({ n: 0 });
		},
	);
	it("rejects stale expected pins without history or runtime effects", async () => {
		const { client, sqlite } = activationSetup();
		await expect(
			client.activatePolicyPackRevision({
				...activation,
				expectedRevisionId: null,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite
				.prepare("SELECT count(*) n FROM tedi_control_plane_binding_history")
				.get(),
		).toEqual({ n: 0 });
		expect(runtime.triggerCronSync).not.toHaveBeenCalled();
	});
	it.each(["draft", "archived", "app", "unpublished", "foreign"])(
		"rejects an ineligible %s revision",
		async (kind) => {
			const { client, sqlite } = activationSetup();
			if (kind === "app")
				sqlite
					.prepare("UPDATE policy_packs SET target='app' WHERE id=?")
					.run(newId);
			else if (kind === "unpublished")
				sqlite
					.prepare("UPDATE policy_packs SET published_at=NULL WHERE id=?")
					.run(newId);
			else if (kind === "foreign")
				sqlite
					.prepare(
						"UPDATE policy_packs SET scope='organization',organization_id='org-1' WHERE id=?",
					)
					.run(newId);
			else
				sqlite
					.prepare("UPDATE policy_packs SET status=? WHERE id=?")
					.run(kind, newId);
			await expect(
				client.activatePolicyPackRevision(activation),
			).rejects.toMatchObject({
				code: kind === "foreign" ? "NOT_FOUND" : "BAD_REQUEST",
			});
			expect(runtime.triggerCronSync).not.toHaveBeenCalled();
		},
	);
	it("allows a same-target-organization policy", async () => {
		const { client, sqlite } = activationSetup();
		sqlite
			.prepare(
				"UPDATE policy_packs SET scope='organization',organization_id=? WHERE id=?",
			)
			.run(orgId, newId);
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			reconciled: true,
		});
	});
	it.each(["m2m", "tedi", "service-binding"])(
		"rejects %s even with platform authority",
		async (authType) => {
			const { client, context } = activationSetup();
			context.authType = authType as BaseContext["authType"];
			context.serviceAccount = {
				scope: "platform:admin",
			} as BaseContext["serviceAccount"];
			context.tediScopes = ["platform:admin"];
			await expect(
				client.activatePolicyPackRevision(activation),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("rejects tenant owners and unscoped API keys while accepting scoped operator keys", async () => {
		const { client, context } = activationSetup();
		context.user!.scope = "";
		await expect(
			client.activatePolicyPackRevision(activation),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		context.authType = "apikey";
		context.apiKey = {
			id: "operator",
			scopes: ["settings:write"],
		} as BaseContext["apiKey"];
		await expect(
			client.activatePolicyPackRevision(activation),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		context.apiKey!.scopes = ["platform:admin"];
		expect(await client.activatePolicyPackRevision(activation)).toMatchObject({
			reconciled: true,
		});
	});
	it.each(["invalidation", "sync", "diagnostic"])(
		"reports committed binding and partial %s failure, allowing retry",
		async (failure) => {
			const { client, sqlite } = activationSetup();
			if (failure === "invalidation")
				runtime.invalidateConfig.mockResolvedValueOnce(false);
			if (failure === "sync")
				runtime.triggerCronSync.mockRejectedValueOnce(new Error("unavailable"));
			if (failure === "diagnostic")
				runtime.triggerCronSync.mockResolvedValueOnce({
					...syncResult,
					cronBootstrap: {
						...syncResult.cronBootstrap,
						ok: false,
						errors: ["unavailable"],
					},
				});
			expect(await client.activatePolicyPackRevision(activation)).toMatchObject(
				{
					bindingApplied: true,
					reconciled: false,
					currentRevisionId: newId,
					error: expect.any(String),
				},
			);
			expect(await client.activatePolicyPackRevision(activation)).toMatchObject(
				{ reconciled: true },
			);
			expect(
				sqlite
					.prepare("SELECT count(*) n FROM tedi_control_plane_binding_history")
					.get(),
			).toEqual({ n: 1 });
		},
	);
});
