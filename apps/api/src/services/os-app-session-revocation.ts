/**
 * Cut live workspace app sessions after access fell. The API already re-checks
 * the caller on every app call, so a removed collaborator's next call fails;
 * this closes what is still open in the workspace app host: sessions signed
 * before the change and calls already running. The host refuses sessions the
 * named principals were issued up to now and restarts the workspace's apps.
 * App storage is kept.
 */
import { serviceBindingFetch } from "@tedix/api-client/internal";

export async function cutWorkspaceAppSessions(
	env: Pick<CloudflareEnv, "TEDI_SERVICE">,
	input: {
		organizationId: string;
		workspaceId: string;
		principalIds: readonly string[];
	},
): Promise<{ cut: boolean }> {
	if (input.principalIds.length === 0) return { cut: false };
	try {
		const response = await serviceBindingFetch(env.TEDI_SERVICE)(
			"https://tedi-runtime/__internal/workspace-app/revoke",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({
					organizationId: input.organizationId,
					workspaceId: input.workspaceId,
					principalIds: [...new Set(input.principalIds)],
					at: Math.floor(Date.now() / 1000),
				}),
			},
		);
		if (!response.ok) throw new Error(`host answered ${response.status}`);
		return { cut: true };
	} catch (error) {
		// The access change is already written and every later call re-checks
		// it; a host that cannot be reached only keeps calls already running.
		console.warn("os_app_session_cut_failed", {
			workspaceId: input.workspaceId,
			principals: input.principalIds.length,
			error: error instanceof Error ? error.message : String(error),
		});
		return { cut: false };
	}
}
