import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import worker, { InternalEntrypoint } from "../src/index";
import type { WorkspaceEnv } from "../src/env";

const scope = {
	organizationId: "org_migration_fixture",
	workspaceId: "11111111-1111-4111-8111-111111111119",
};
const base = `https://workspace.internal/migration/workspaces/${scope.organizationId}/${scope.workspaceId}`;
const token = "migration-test-token";

function entrypoint() {
	return new InternalEntrypoint(createExecutionContext(), {
		...(env as unknown as WorkspaceEnv),
		MIGRATE_WORKSPACES_TOKEN: token,
	});
}

describe("migration through the RPC service entrypoint", () => {
	test("blocks authenticated imports through public and service fetch before addressing an object", async () => {
		const guardedEnv = {
			MIGRATE_WORKSPACES_TOKEN: token,
			// An absent namespace proves rejection precedes even an object wake.
		} as WorkspaceEnv;
		const service = new InternalEntrypoint(
			createExecutionContext(),
			guardedEnv,
		);
		for (const fetch of [
			(request: Request) => worker.fetch(request, guardedEnv),
			(request: Request) => service.fetch(request),
		]) {
			for (const authorization of [
				"",
				"Bearer incorrect-test-token",
				`Bearer ${token}`,
			]) {
				const response = await fetch(
					new Request(`${base}/import`, {
						method: "POST",
						headers: { authorization },
						body: "invalid JSON",
					}),
				);
				expect(response.status).toBe(
					authorization === `Bearer ${token}` ? 409 : 401,
				);
				if (response.status === 409)
					expect(await response.json()).toMatchObject({
						code: "MEMORY_MIGRATION_PREREQUISITES_UNPROVEN",
					});
			}
		}
	});

	test("describes the real workspace schema through the bound entrypoint", async () => {
		const response = await entrypoint().fetch(
			new Request(base, {
				headers: {
					authorization: `Bearer ${token}`,
					"X-Workspace-Org": scope.organizationId,
					"X-Workspace-Id": scope.workspaceId,
				},
			}),
		);
		expect(response.status).toBe(200);
		const description = (await response.json()) as typeof scope & {
			migrations: string[];
		};
		expect(description).toMatchObject(scope);
		expect(description.migrations).toContain(
			"20261108100233_workspace_chat_tables",
		);
	});

	test("rejects missing or incorrect migration bearers", async () => {
		for (const authorization of ["", "Bearer incorrect-test-token"]) {
			const response = await entrypoint().fetch(
				new Request(base, { headers: { authorization } }),
			);
			expect(response.status).toBe(401);
		}
	});

	test("preserves the method guard and ordinary workspace header requirement", async () => {
		const response = await entrypoint().fetch(
			new Request(base, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(response.status).toBe(405);
		const unrelated = await entrypoint().fetch(
			new Request("https://workspace.internal/subscribe"),
		);
		expect(unrelated.status).toBe(400);
	});
});
