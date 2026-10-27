import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import * as z from "zod";
import { requestFirstPartyMcp } from "../../../lib/first-party-mcp";
import { codeModeResultData } from "./write-codemode";
import {
	FactoryHealthRunSchema,
	FactoryHealthSchema,
} from "@tedix/api-contract/schemas/factories";
import type { WriteProposalEnv } from "./write-proposal";

const ChatLaneSchema = FactoryHealthSchema.pick({ slug: true, name: true });
export type FactoryChatLane = z.infer<typeof ChatLaneSchema>;

const ChatHealthSchema = FactoryHealthSchema.pick({
	slug: true,
	name: true,
	skillId: true,
	ownerTediId: true,
	verdict: true,
	reason: true,
	scheduleEnabled: true,
	nextFireAt: true,
}).extend({
	runs: z.array(FactoryHealthRunSchema.pick({ runId: true, status: true })),
});
export type FactoryChatHealth = z.infer<typeof ChatHealthSchema>;

/**
 * Chat names at most this many factories. Code Mode keeps a result over its
 * budget (~24k characters) behind a handle, so returning every lane's full
 * health (39 KB for an organization with 43 factories) failed the schema
 * parse and chat answered "I could not read current factory health". Lane
 * names stay well under the budget at this cap; one factory's health is read
 * separately once chat knows which one is meant.
 */
export const FACTORY_CHAT_LANE_LIMIT = 150;

export interface FactoryChatReader {
	lanes(): Promise<{ lanes: FactoryChatLane[]; total: number }>;
	health(slug: string): Promise<FactoryChatHealth>;
}

/** Read the same discoverable health tool agents use, under the initiating user's scope. */
export function factoryChatReader(
	env: WriteProposalEnv,
	orgId: string,
	appSlug: string,
	userId?: string,
	workspaceId?: string,
): FactoryChatReader {
	// Live, the first chat turn after a quiet period failed the read and the
	// identical retry succeeded. Both reads are side-effect free, so retry once.
	const run = async (code: string): Promise<unknown> => {
		try {
			return await runOnce(code);
		} catch {
			return await runOnce(code);
		}
	};
	const runOnce = async (code: string): Promise<unknown> => {
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
			{ name: "code", arguments: { code } },
		);
		if (result.isError) throw new Error("Factory health could not be read");
		return codeModeResultData(result);
	};
	return {
		async lanes() {
			const data = await run(
				`async () => { const workspaceId = ${codeModeLiteral(workspaceId ?? null)}; const page = await projects.inspect_factory_health({ runs: 1 }); const lanes = page.data.filter(lane => !workspaceId || lane.workspaceId === workspaceId); return { total: lanes.length, lanes: lanes.slice(0, ${FACTORY_CHAT_LANE_LIMIT}).map(({ slug, name }) => ({ slug, name })) }; }`,
			);
			return z
				.object({
					total: z.number().int().nonnegative(),
					lanes: ChatLaneSchema.array().max(FACTORY_CHAT_LANE_LIMIT),
				})
				.parse(data);
		},
		async health(slug) {
			const data = await run(
				`async () => { const page = await projects.inspect_factory_health({ factory: ${codeModeLiteral(slug)}, runs: 1 }); const lane = page.data[0]; if (!lane) throw new Error("Factory not found"); const { name, skillId, ownerTediId, verdict, reason, scheduleEnabled, nextFireAt, runs } = lane; return { slug: lane.slug, name, skillId, ownerTediId, verdict, reason: reason.slice(0, 500), scheduleEnabled, nextFireAt, runs: runs.slice(0, 1).map(({ runId, status }) => ({ runId, status })) }; }`,
			);
			return ChatHealthSchema.parse(data);
		},
	};
}
