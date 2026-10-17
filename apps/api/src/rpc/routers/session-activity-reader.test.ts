import { createRouterClient } from "@orpc/server";
import * as runs from "@tedix/db/queries/skill-runs";
import * as activity from "@tedix/db/queries/agent-session-requests";
import * as delegation from "../../services/personal-resource-delegation-authority";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { workAgentSessionsContractRouter } from "./work-agent-sessions";
import type { BaseContext } from "../orpc";

const id = "10000000-0000-4000-8000-000000000001";
const source = {
	workspaceResourceId: id,
	workspaceId: id,
	providerId: "tedix-session-activity",
	resourceType: "session_activity",
	providerResourceId: "canonical-ada",
	connectionScope: "user",
	personalOwnerUserId: "ada-sub",
	connectionInstanceId: id,
	delegationId: id,
	requiredScopes: [],
	operations: ["read"],
	toolIds: ["list_agent_session_activity"],
};
function client() {
	return createRouterClient(workAgentSessionsContractRouter, {
		context: {
			authType: "service-binding",
			organizationId: id,
			tediId: id,
			tediScopes: ["mcp:work.read"],
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Tedi-Id": id,
				"X-Tedix-Tedi-Scopes": "mcp:work.read",
				"X-Tedix-Mcp-Tool-Id": "list_agent_session_activity",
				"X-Tedix-Skill-Run-Id": id,
				"X-Tedix-Workflow-Execution-Epoch": "1",
			}),
		} as BaseContext,
	});
}
beforeEach(() => vi.restoreAllMocks());
describe("delegated session activity reader", () => {
	it("reports missing consent without reading any private rows", async () => {
		vi.spyOn(runs, "getSkillRun").mockResolvedValue({
			id,
			tediId: id,
			skillId: id,
			skillRevision: 1,
			resourceAccessEnvelope: null,
		} as never);
		const read = vi.spyOn(activity, "listAgentSessionActivity");
		expect(
			await client().listActivity({ since: "2026-10-01T00:00:00Z" }),
		).toMatchObject({ status: "needs_grant", data: [] });
		expect(read).not.toHaveBeenCalled();
	});
	it("reads only the grant's canonical ledger owner, scrubs secrets and rechecks consent", async () => {
		vi.spyOn(runs, "getSkillRun").mockResolvedValue({
			id,
			tediId: id,
			skillId: id,
			skillRevision: 1,
			resourceAccessEnvelope: { version: 1, sources: [source] },
		} as never);
		const auth = vi
			.spyOn(delegation, "authorizePersonalResourceDelegation")
			.mockResolvedValue({
				delegation: { accountSubject: "canonical-ada" },
			} as never);
		const read = vi
			.spyOn(activity, "listAgentSessionActivity")
			.mockResolvedValue([
				{
					id,
					harness: "codex",
					sessionKey: "chat",
					repository: "sample",
					kind: "turn",
					sourceAt: "2026-10-01T01:00:00Z",
					body: "Authorization: Bearer secret-value",
					activity: "api_key=never-share-this",
				},
			] as never);
		const result = await client().listActivity({
			since: "2026-10-01T00:00:00Z",
		});
		expect(read).toHaveBeenCalledWith(
			{},
			{
				organizationId: id,
				userId: "canonical-ada",
				since: "2026-10-01T00:00:00Z",
				limit: 50,
			},
		);
		expect(auth).toHaveBeenCalledTimes(2);
		expect(result.status).toBe("ready");
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(JSON.stringify(result)).not.toContain("never-share-this");
	});
	it("does not deliver bytes when consent is revoked during the query", async () => {
		vi.spyOn(runs, "getSkillRun").mockResolvedValue({
			id,
			tediId: id,
			skillId: id,
			skillRevision: 1,
			resourceAccessEnvelope: { version: 1, sources: [source] },
		} as never);
		vi.spyOn(delegation, "authorizePersonalResourceDelegation")
			.mockResolvedValueOnce({
				delegation: { accountSubject: "canonical-ada" },
			} as never)
			.mockRejectedValueOnce(new Error("revoked"));
		vi.spyOn(activity, "listAgentSessionActivity").mockResolvedValue([]);
		await expect(
			client().listActivity({ since: "2026-10-01T00:00:00Z" }),
		).rejects.toThrow("revoked");
	});
});
