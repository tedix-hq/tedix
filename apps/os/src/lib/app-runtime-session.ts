import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { AppRuntimeRole } from "@tedix/api-contract/schemas/os-app-runtime";

interface Scope {
	workspaceId: string;
	gadgetId: string;
}
interface Session {
	session: string;
	expiresAt: number;
	role: AppRuntimeRole;
	revisionId: string;
}
interface RuntimeApi {
	open(scope: Scope): Promise<Session>;
	call(
		input: Scope & { session: string; method: string; args: JsonValue[] },
	): Promise<{ result: JsonValue }>;
}

/** Keep the signed capability in the host, never in the sandbox or query cache. */
export function createAppRuntimeServerCall(
	api: RuntimeApi,
	scope: Scope & { revisionId: string },
) {
	let opening: Promise<Session> | undefined;
	let session: Session | undefined;
	return async (method: string, args: JsonValue[]): Promise<JsonValue> => {
		if (!session || session.expiresAt * 1000 <= Date.now() + 5000) {
			opening ??= api.open({
				workspaceId: scope.workspaceId,
				gadgetId: scope.gadgetId,
			});
			try {
				session = await opening;
			} finally {
				opening = undefined;
			}
		}
		if (session.revisionId !== scope.revisionId)
			throw new Error("The app revision changed. Reopen the app to continue.");
		const response = await api.call({
			workspaceId: scope.workspaceId,
			gadgetId: scope.gadgetId,
			session: session.session,
			method,
			args,
		});
		return response.result;
	};
}
