import { createLink, createORPCClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import type { RouterContractClient } from "@tedix/api-contract/types";

export async function verifyLocalFiles(
	osOrigin: string,
	workspaceId: string,
	outputId: string,
) {
	const client: RouterContractClient<ApiContract> = createORPCClient(
		createLink({
			url: `${osOrigin}/api/rpc`,
			fetch: async (request, init) => {
				const response = await fetch(request, init);
				console.log(
					`HTTP ${response.status} ${new URL(request instanceof Request ? request.url : String(request)).pathname}`,
				);
				if (response.status !== 200)
					throw new Error(
						`Local file acceptance requires HTTP 200: ${await response.text()}`,
					);
				return response;
			},
		}),
	);
	const { gadget } = await client.osWorkspaces.gadgets.installOutputEditor({
		workspaceId,
		outputId,
		kind: "sheet",
	});
	await client.osAppRuntime.open({ workspaceId, gadgetId: gadget.id });
	await client.osWorkspaces.outputs.create({
		workspaceId,
		kind: "sheet",
		title: "Local acceptance sheet",
	});
}
