import { resolveStoredLoginAuth } from "./auth-resolve";
import { getCurrentWorkspace } from "./credential-store";
import { fileDiscoveryCache } from "./discovery-cache";
import { TedixHomeClient } from "./home-client";
import { fileNativeBootstrapCache } from "./native-bootstrap-cache";
import { resolveOrganizationTarget } from "./organization-target";
import { parseOptions } from "./options";
import { callConfiguredNativeTool } from "./work-native";
import { type NativeToolContext } from "./work";

/** The wrapper observes as the owner; it never borrows a child's executor identity. */
export function createLaneReporter() {
	let context: NativeToolContext | undefined;
	let client: TedixHomeClient | undefined;
	let selectedScope: string | undefined;
	return {
		async report(input: Record<string, unknown>, scope: string[]) {
			if (
				selectedScope !== undefined &&
				selectedScope !== JSON.stringify(scope)
			)
				throw new Error("Lane reporter organization changed");
			if (!context) {
				const { options } = parseOptions([...scope, "work"]);
				const workspace =
					options.workspace || getCurrentWorkspace() || "default";
				const stored = await resolveStoredLoginAuth(workspace, {
					consentPrompt: false,
				});
				const auth = stored.auth;
				if (!auth)
					throw new Error(
						stored.loginError ?? "Lane reporting needs an existing owner login",
					);
				const url = options.urlExplicit
					? options.url
					: (auth.mcpUrl ?? options.url);
				const target = resolveOrganizationTarget({
					url,
					command: "work",
					workspace,
					organization: options.organization,
					accessToken:
						(await auth.oauthProvider?.tokens())?.access_token ??
						auth.headers.Authorization?.replace(/^Bearer\s+/i, ""),
				});
				client = new TedixHomeClient({
					url,
					headers: { ...auth.headers, ...target.headers },
					oauthProvider: auth.oauthProvider,
					discoveryCache: fileDiscoveryCache(),
					timeoutMs: 60_000,
				});
				context = {
					client,
					nativeCacheScope: JSON.stringify([target.workspace, auth.source]),
					workspace: target.workspace,
					mcpUrl: url,
					bootstrapCache: fileNativeBootstrapCache(),
				};
				selectedScope = JSON.stringify(scope);
			}
			return callConfiguredNativeTool(
				context,
				"work.report_work_agent_session_status",
				input,
			);
		},
		async close() {
			await client?.close();
		},
	};
}
