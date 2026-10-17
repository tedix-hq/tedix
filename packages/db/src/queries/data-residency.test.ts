import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	getOrganizationResidencyPolicy,
	setOrganizationResidencyPolicy,
	listResidencyProviders,
	publishResidencyProvider,
	recordResidencyExecution,
} from "./data-residency";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org_lark'), ('org_elm'); CREATE TABLE audit_events (id TEXT PRIMARY KEY, organization_id TEXT, actor_id TEXT, actor_type TEXT, action TEXT, resource_type TEXT, resource_id TEXT, metadata TEXT, timestamp INTEGER)",
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261017223106_organization-data-residency/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const member = {
	memberKey: "regional-text",
	modalities: ["text" as const, "image" as const],
	revision: 1,
	jurisdiction: "eu" as const,
	enabled: true,
	credentialRef: "REGIONAL_MODEL_KEY",
	evidenceRef: "https://evidence.example/regional-processing",
	expiresAt: "2027-01-01T00:00:00.000Z",
	execution: {
		provider: "azure-openai" as const,
		requestModel: "text-model",
		providerResource: "lark-eu",
		providerOrigin: "https://lark-eu.openai.azure.com",
		deployment: "text-model",
		apiKind: "azure-responses" as const,
		transportKind: "gateway-https" as const,
		gatewayAccountId: "example-account",
		gatewayId: "example-gateway",
	},
};
describe("organization residency persistence", () => {
	it("defaults without a row and changes only the selected organization, with CAS and atomic audit", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(await getOrganizationResidencyPolicy(db, "org_lark")).toBeNull();
			const update = {
				organizationId: "org_lark",
				mode: "eu" as const,
				expectedRevision: 0,
				actorId: "owner_lark",
				now: "2026-10-18T00:00:00.000Z",
			};
			expect(await setOrganizationResidencyPolicy(db, update)).toMatchObject({
				mode: "eu",
				revision: 1,
			});
			expect(
				await getOrganizationResidencyPolicy(
					createD1Facade(sqlite),
					"org_lark",
				),
			).toMatchObject({ mode: "eu", revision: 1 });
			await expect(setOrganizationResidencyPolicy(db, update)).rejects.toThrow(
				"revision conflict",
			);
			expect(await getOrganizationResidencyPolicy(db, "org_elm")).toBeNull();
			await expect(
				setOrganizationResidencyPolicy(db, {
					...update,
					organizationId: "org_elm",
					expectedRevision: 1,
				}),
			).rejects.toThrow("revision conflict");
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM audit_events").get()?.n,
			).toBe(1);
			expect(
				await setOrganizationResidencyPolicy(db, {
					...update,
					mode: "unrestricted",
					expectedRevision: 1,
				}),
			).toMatchObject({ mode: "unrestricted", revision: 2 });
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM audit_events").get()?.n,
			).toBe(2);
		} finally {
			sqlite.close();
		}
	});
	it("rolls back policy when its audit write fails", async () => {
		const { sqlite, db } = fixture();
		try {
			sqlite.exec(
				"CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
			);
			await expect(
				setOrganizationResidencyPolicy(db, {
					organizationId: "org_lark",
					mode: "eu",
					expectedRevision: 0,
					actorId: "owner_lark",
					now: "2026-10-18T00:00:00.000Z",
				}),
			).rejects.toThrow();
			expect(await getOrganizationResidencyPolicy(db, "org_lark")).toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("keeps immutable catalog revisions and honors the latest disabled entry", async () => {
		const { sqlite, db } = fixture();
		try {
			await publishResidencyProvider(
				db,
				member,
				"operator",
				"2026-10-18T00:00:00.000Z",
			);
			await expect(
				publishResidencyProvider(
					db,
					member,
					"operator",
					"2026-10-18T00:00:00.000Z",
				),
			).rejects.toThrow();
			await publishResidencyProvider(
				db,
				{ ...member, revision: 2, enabled: false },
				"operator",
				"2026-10-18T00:00:00.000Z",
			);
			expect(await listResidencyProviders(db)).toEqual([
				{ ...member, revision: 2, enabled: false },
			]);
			await recordResidencyExecution(db, {
				executionId: "execution-lark",
				organizationId: "org_lark",
				policyRevision: 1,
				memberKey: member.memberKey,
				poolRevision: 1,
				providerOrigin: member.execution.providerOrigin,
				credentialRef: member.credentialRef,
				evidenceRef: member.evidenceRef,
				createdAt: "2026-10-18T00:00:00.000Z",
			});
			const receipt = sqlite
				.prepare("SELECT * FROM residency_execution_receipts")
				.get();
			expect(receipt?.credential_ref).toBe(member.credentialRef);
			expect(receipt).not.toHaveProperty("encrypted_value");
		} finally {
			sqlite.close();
		}
	});
});

it("does not overwrite execution evidence on a conflicting policy replay", async () => {
	const { sqlite, db } = fixture();
	try {
		const receipt = {
			executionId: "execution-lark",
			organizationId: "org_lark",
			policyRevision: 1,
			memberKey: member.memberKey,
			poolRevision: 1,
			providerOrigin: member.execution.providerOrigin,
			credentialRef: member.credentialRef,
			evidenceRef: member.evidenceRef,
			createdAt: "2026-10-18T00:00:00.000Z",
		};
		await recordResidencyExecution(db, receipt);
		await recordResidencyExecution(db, {
			...receipt,
			createdAt: "2026-10-18T00:01:00.000Z",
		});
		await expect(
			recordResidencyExecution(db, { ...receipt, policyRevision: 2 }),
		).rejects.toThrow("Residency execution receipt conflict");
		expect(
			sqlite
				.prepare("SELECT policy_revision FROM residency_execution_receipts")
				.get()?.policy_revision,
		).toBe(1);
	} finally {
		sqlite.close();
	}
});
