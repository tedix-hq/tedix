import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "@tedix/db/schema/control-plane";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { issuePortableGitReadAccess } from "./portable-export-access";

const tediId = "a4d6765f-786b-446b-b9d1-3573b4330b9a";
const organizationId = "11111111-1111-4111-8111-111111111111";
const accountId = "a".repeat(32);
const remote = `https://${accountId}.artifacts.cloudflare.net/git/example-installation/${tediId}.git`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(tedis, runtimeProfiles, policyPacks, workspaceTemplateSets),
	);
	sqlite
		.prepare("INSERT INTO tedis(id,organization_id,name,slug) VALUES (?,?,?,?)")
		.run(tediId, organizationId, "Tedi A", "tedi-a");
	const createToken = vi.fn(async () => ({
		plaintext: "private-token?expires=ignored",
	}));
	const info = vi.fn(async () => ({ remote }));
	const get = vi.fn(async () => ({ createToken, info }));
	const context = {
		authType: "user",
		organizationId,
		db: createDbClient(createD1Facade(sqlite)),
		env: {
			ARTIFACTS: { get },
			CF_ACCOUNT_ID: accountId,
			API_URL: "https://api.tedix.dev",
			SECRETS_MASTER_KEY: "test-master-key",
		},
	} as unknown as BaseContext;
	return { sqlite, context, get, createToken, info };
}

describe("portable Git read access", () => {
	it("mints only a read token after organization ownership is checked", async () => {
		const { sqlite, context, get, createToken } = fixture();
		try {
			const access = await issuePortableGitReadAccess(context, tediId);
			expect(access).toMatchObject({
				repoFound: true,
				remote,
				token: "private-token",
				snapshot: {
					url: `https://api.tedix.dev/portable/tedis/${tediId}/snapshot`,
				},
			});
			expect(get).toHaveBeenCalledWith(tediId);
			expect(createToken).toHaveBeenCalledWith("read", 3_600);
		} finally {
			sqlite.close();
		}
	});

	it("exports binding shapes without source control-plane IDs", async () => {
		const { sqlite, context } = fixture();
		try {
			sqlite
				.prepare(
					"INSERT INTO runtime_profiles(id,organization_id,name,slug,config,scope,version) VALUES (?,?,?,?,?,?,?)",
				)
				.run(
					"profile-a",
					organizationId,
					"Default",
					"default",
					"{}",
					"organization",
					3,
				);
			sqlite
				.prepare("UPDATE tedis SET runtime_profile_id=? WHERE id=?")
				.run("profile-a", tediId);
			const access = await issuePortableGitReadAccess(context, tediId);
			expect(access.bindings.runtimeProfile).toEqual({
				scope: "organization",
				slug: "default",
				version: 3,
			});
			expect(JSON.stringify(access)).not.toContain("profile-a");
			expect(JSON.stringify(access.bindings)).not.toContain(organizationId);
		} finally {
			sqlite.close();
		}
	});

	it("does not touch Artifacts for another organization", async () => {
		const { sqlite, context, get } = fixture();
		try {
			await expect(
				issuePortableGitReadAccess(
					{
						...context,
						organizationId: "bff1a566-832b-4486-9f5d-87ced3fcabe0",
					},
					tediId,
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(get).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it("does not mint a token for a tedi principal", async () => {
		const { sqlite, context, get } = fixture();
		try {
			await expect(
				issuePortableGitReadAccess({ ...context, authType: "tedi" }, tediId),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(get).not.toHaveBeenCalled();
		} finally {
			sqlite.close();
		}
	});

	it("reports an uninitialized repo without inventing history", async () => {
		const { sqlite, context, get } = fixture();
		get.mockRejectedValueOnce(
			Object.assign(new Error("missing"), { code: "NOT_FOUND" }),
		);
		try {
			await expect(
				issuePortableGitReadAccess(context, tediId),
			).resolves.toMatchObject({
				repoFound: false,
				identity: { name: "Tedi A", slug: "tedi-a" },
				bindings: {
					runtimeProfile: null,
					policyPack: null,
					workspaceTemplateSet: null,
					apps: [],
				},
			});
		} finally {
			sqlite.close();
		}
	});
});
