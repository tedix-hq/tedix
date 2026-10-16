import { requestFirstPartyMcp } from "../../../lib/first-party-mcp";
import { codeModeResultData } from "./write-codemode";
import { FactoryHealthSchema } from "@tedix/api-contract/schemas/factories";
import type { WriteProposalEnv } from "./write-proposal";

const ChatHealthSchema = FactoryHealthSchema.pick({
	slug: true,
	name: true,
	skillId: true,
	ownerTediId: true,
	verdict: true,
	reason: true,
	scheduleEnabled: true,
	nextFireAt: true,
	runs: true,
});
export type FactoryChatHealth = ReturnType<typeof ChatHealthSchema.parse>;

/** Read the same discoverable health tool agents use, under the initiating user's scope. */
export async function readFactoryChatHealth(
	env: WriteProposalEnv,
	orgId: string,
	appSlug: string,
	userId?: string,
	workspaceId?: string,
): Promise<FactoryChatHealth[]> {
	if (!env.MCP_SERVICE || !env.MCP_URL)
		throw new Error("Factory health service is unavailable");
	const result = await requestFirstPartyMcp(
		{
			url: `${env.MCP_URL}/mcp`,
			clientName: "tedix-home",
			fetch: (url, init) => env.MCP_SERVICE!.fetch(url, init),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Kernel": "true",
				"X-Tedix-Org-Id": orgId,
				"X-Tedix-Host": `${appSlug}.${new URL(env.MCP_URL).hostname}`,
				...(userId ? { "X-Tedix-Acting-User": userId } : {}),
				...(env.PLATFORM_SERVICE_TOKEN
					? { Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}` }
					: {}),
			},
		},
		"tools/call",
		{
			name: "code",
			arguments: {
				code: `async () => { const workspaceId = ${JSON.stringify(workspaceId ?? null)}; const tool = await discover.describe({ callable: "projects.inspect_factory_health" }); if (!tool) throw new Error("Factory health tool unavailable"); const page = await projects.inspect_factory_health({ runs: 1 }); return page.data.filter(lane => !workspaceId || lane.workspaceId === workspaceId).map(({ slug, name, skillId, ownerTediId, verdict, reason, scheduleEnabled, nextFireAt, runs }) => ({ slug, name, skillId, ownerTediId, verdict, reason, scheduleEnabled, nextFireAt, runs })); }`,
			},
		},
	);
	if (result.isError) throw new Error("Factory health could not be read");
	return ChatHealthSchema.array().parse(codeModeResultData(result));
}
