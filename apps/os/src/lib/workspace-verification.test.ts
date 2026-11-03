import {
	createLink,
	createORPCClient,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import { describe, expect, it } from "vite-plus/test";
import { isWorkspaceAccessDenied } from "./workspace-verification";

describe("workspace access HTTP errors", () => {
	it.each([401, 403, 404, 503])(
		"classifies the actual oRPC error from HTTP %s without a valid RPC envelope",
		async (status) => {
			const client: RouterContractClient<ApiContract> = createORPCClient(
				createLink({
					url: "https://fictional.invalid/rpc",
					fetch: async () =>
						new Response(
							JSON.stringify({
								json: { code: "FORBIDDEN", message: "Access changed" },
							}),
							{ status, headers: { "content-type": "application/json" } },
						),
				}),
			);
			let error: unknown;
			try {
				await client.osCollaborators.access({
					workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({
				name: "MalformedResponseError",
				response: { status },
			});
			expect(isWorkspaceAccessDenied(error)).toBe(status !== 503);
		},
	);
});
