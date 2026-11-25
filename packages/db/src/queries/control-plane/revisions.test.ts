import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createDbQueryClient } from "../../query-client";
import { tediControlPlaneBindingHistory } from "../../schema/control-plane-history";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { organizations } from "../../schema/organizations";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createPolicyPack,
	deletePolicyPack,
	getRuntimeProfileById,
} from "./definitions";
import {
	listRuntimeProfileRevisions,
	listTediControlPlaneBindingHistory,
	publishPolicyPackRevision,
	publishRuntimeProfileRevision,
	rollbackRuntimeProfileRevision,
} from "./revisions";
import { getActiveSystemPolicy } from "./system-policy";

function setup(): DbClient {
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
		INSERT INTO runtime_profiles
			(id, organization_id, name, slug, scope, status, version, config)
		VALUES ('rp-1', 'org-1', 'Default', 'default', 'organization', 'active', 1, '{"model":"a"}');
		INSERT INTO tedis
			(id, organization_id, name, slug, runtime_profile_id)
		VALUES ('tedi-1', 'org-1', 'Tedi', 'tedi', 'rp-1');
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("immutable control-plane revisions", () => {
	it("refreshes ownerless system snapshots across clients on creation, publication and revocation", async () => {
		const db = setup();
		const reader = createDbQueryClient(db.$client);
		const input = {
			name: "Trust",
			slug: "installation-trust",
			scope: "system" as const,
			target: "shared" as const,
			status: "active" as const,
			version: 1,
			publishedBy: "operator",
			definition: { marker: "first" },
		};
		await createPolicyPack(db, { ...input, organizationId: "org-1" });
		expect(await getActiveSystemPolicy(reader, input.slug)).toBeNull();
		const policy = await createPolicyPack(db, { ...input, version: 2 });
		expect(await getActiveSystemPolicy(reader, input.slug)).toEqual({
			version: 2,
			definition: input.definition,
		});
		const published = await publishPolicyPackRevision(db, {
			revisionId: policy.id,
			publishedBy: "operator",
			definition: { marker: "second" },
		});
		if (!published.ok) throw new Error("expected policy publication");
		expect(await getActiveSystemPolicy(reader, input.slug)).toEqual({
			version: 3,
			definition: { marker: "second" },
		});
		expect(await deletePolicyPack(db, published.revision.id)).toBe(true);
		expect(await getActiveSystemPolicy(reader, input.slug)).toBeNull();
	});

	it("migrates all stored Auto slots with recovery values and keeps a later Auto choice", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(organizations, runtimeProfiles));
			const auto = "cloudflare/auto";
			const terra = "azure-openai/gpt-6.1-terra";
			const configs = [
				{
					modelPolicy: {
						chatModelRef: auto,
						cronModelRef: auto,
						observerModelRef: auto,
					},
				},
				{
					modelPolicy: {
						chatModelRef: auto,
						cronModelRef: "chosen/cron",
						observerModelRef: null,
						temperature: 0.7,
					},
					channelPolicy: { enabled: true },
				},
				{ modelPolicy: { chatModelRef: "chosen/chat", cronModelRef: auto } },
				{ modelPolicy: { chatModelRef: terra, observerModelRef: auto } },
				{ modelPolicy: { chatModelRef: "chosen/chat", cronModelRef: null } },
				{ channelPolicy: { enabled: true } },
			];
			const insert = sqlite.prepare(`INSERT INTO runtime_profiles
				(id, name, slug, scope, status, version, config)
				VALUES (?, 'Profile', ?, 'system', ?, ?, ?)`);
			for (const [index, config] of configs.entries()) {
				insert.run(
					`rp-${index}`,
					`profile-${index}`,
					index === 0 ? "archived" : "active",
					index + 1,
					JSON.stringify(config),
				);
			}
			sqlite.exec(
				readFileSync(
					new URL(
						"../../../drizzle/20261122091911_runtime_profile_auto_to_terra/migration.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const db = createDbClient(createD1Facade(sqlite));
			for (const [index, config] of configs.entries()) {
				const migrated = await getRuntimeProfileById(db, `rp-${index}`);
				if (index < 4) {
					const policy: Record<string, string | number | null | undefined> = {
						...config.modelPolicy,
					};
					for (const slot of [
						"chatModelRef",
						"cronModelRef",
						"observerModelRef",
					] as const) {
						if (policy[slot] === auto) policy[slot] = terra;
					}
					expect(migrated?.config).toEqual({
						...config,
						modelPolicy: policy,
						modelPolicyBeforeAutoToTerra20261122: config.modelPolicy,
					});
				} else {
					expect(migrated?.config).toEqual(config);
				}
			}

			// Publication uses the normal write path after the one-time migration.
			const chosen = await publishRuntimeProfileRevision(db, {
				revisionId: "rp-3",
				config: {
					modelPolicy: {
						chatModelRef: auto,
						cronModelRef: auto,
						observerModelRef: auto,
					},
				},
			});
			if (!chosen.ok) throw new Error("expected Auto publication");
			expect(
				(await getRuntimeProfileById(db, chosen.revision.id))?.config
					.modelPolicy,
			).toEqual({
				chatModelRef: auto,
				cronModelRef: auto,
				observerModelRef: auto,
			});

			// An operator can restore the saved policy without touching other config.
			sqlite.exec(`UPDATE runtime_profiles
				SET config = json_remove(json_set(config, '$.modelPolicy',
					json_extract(config, '$.modelPolicyBeforeAutoToTerra20261122')),
					'$.modelPolicyBeforeAutoToTerra20261122')
				WHERE json_type(config, '$.modelPolicyBeforeAutoToTerra20261122') = 'object'`);
			for (const [index, config] of configs.entries()) {
				expect(
					(await getRuntimeProfileById(db, `rp-${index}`))?.config,
				).toEqual(config);
			}
		} finally {
			sqlite.close();
		}
	});

	it("publishes a successor without mutating the pinned source revision", async () => {
		const db = setup();
		const result = await publishRuntimeProfileRevision(db, {
			revisionId: "rp-1",
			expectedVersion: 1,
			config: { model: "b" },
			changeSummary: "Use model b",
			publishedBy: "user-1",
		});

		expect(result).toMatchObject({
			ok: true,
			revision: {
				version: 2,
				supersedesRevisionId: "rp-1",
				config: { model: "b" },
			},
		});
		expect(await getRuntimeProfileById(db, "rp-1")).toMatchObject({
			version: 1,
			config: { model: "a" },
		});
		const revisions = await listRuntimeProfileRevisions(db, "rp-1");
		expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
		const [tedi] = await db.select().from(tedis);
		expect(tedi?.runtimeProfileId).toBe("rp-1");
	});

	it("rejects publication from a stale family head", async () => {
		const db = setup();
		expect(
			await publishRuntimeProfileRevision(db, {
				revisionId: "rp-1",
				expectedVersion: 2,
				config: { model: "b" },
			}),
		).toEqual({ ok: false, reason: "revision_conflict" });
	});

	it("rolls back by appending a revision, moving one exact pin, and recording history", async () => {
		const db = setup();
		const second = await publishRuntimeProfileRevision(db, {
			revisionId: "rp-1",
			expectedVersion: 1,
			config: { model: "b" },
		});
		if (!second.ok) throw new Error("expected revision publication");
		await db
			.update(tedis)
			.set({ runtimeProfileId: second.revision.id })
			.where(eq(tedis.id, "tedi-1"));

		const rollback = await rollbackRuntimeProfileRevision(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			currentRevisionId: second.revision.id,
			targetRevisionId: "rp-1",
			expectedVersion: 2,
			publishedBy: "user-1",
		});
		expect(rollback).toMatchObject({
			ok: true,
			revision: {
				version: 3,
				rollbackOfRevisionId: "rp-1",
				config: { model: "a" },
			},
		});
		if (!rollback.ok) throw new Error("expected rollback");
		const [tedi] = await db.select().from(tedis);
		expect(tedi?.runtimeProfileId).toBe(rollback.revision.id);
		expect(
			await listTediControlPlaneBindingHistory(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
			}),
		).toMatchObject([
			{
				previousRevisionId: second.revision.id,
				revisionId: rollback.revision.id,
				kind: "runtime_profile",
			},
		]);
	});
});
