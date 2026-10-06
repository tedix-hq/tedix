/** Protocol bootstrap identity; never an organization or business capability. */
import * as z from "zod";
import type { CallerIdentity, ServerContext } from "../server-context";

export const accountProfileSchema = z
	.object({
		id: z.string().min(1).regex(/\S/),
		name: z.string().optional(),
		email: z.string().optional(),
		nickname: z.string().optional(),
	})
	.strict();
export const accountProfileInputSchema = z.object({}).strict();
export const ACCOUNT_PROFILE_SECURITY = [{ type: "oauth2", scopes: [] }];
export function accountProfileEnabled(
	config: { authMode?: string } | undefined,
): boolean {
	return config?.authMode === "authenticated" || config?.authMode === "hybrid";
}
export const accountProfileTool = {
	name: "get_profile",
	title: "Connected Tedix account",
	description:
		"Return the account represented by this request's authenticated credentials. Its opaque identity remains stable across refresh, reconnect, scope and organization selection changes.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	outputSchema: z.toJSONSchema(accountProfileSchema),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		openWorldHint: false,
	},
	securitySchemes: ACCOUNT_PROFILE_SECURITY,
	_meta: { "openai/profile": true, securitySchemes: ACCOUNT_PROFILE_SECURITY },
};

export function accountProfileResult(
	caller: CallerIdentity | undefined,
	args: unknown,
) {
	if (!accountProfileInputSchema.safeParse(args).success) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "get_profile accepts only an empty argument object.",
				},
			],
		};
	}
	// Identity headers reach this function only after edge credential validation.
	// Service impersonation and worker credentials are not personal connections.
	if (
		!caller ||
		!["oauth", "user"].includes(caller.authType) ||
		!caller.userId?.trim()
	) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "An authenticated personal Tedix connection is required.",
				},
			],
			_meta: {
				"mcp/www_authenticate": [
					'Bearer error="invalid_token", error_description="Connect your Tedix account."',
				],
			},
		};
	}
	// Descope's immutable user subject is opaque, unique and never reassigned.
	// Do not include token, session, email or organization in this identifier.
	const profile = accountProfileSchema.parse({
		id: caller.userId,
		...(caller.email ? { email: caller.email, nickname: caller.email } : {}),
	});
	return {
		content: [{ type: "text" as const, text: JSON.stringify(profile) }],
		structuredContent: profile,
	};
}

export function registerAccountProfile(agent: ServerContext): void {
	if (!accountProfileEnabled(agent.appMetadata?.mcpConfig)) return;
	const {
		name,
		inputSchema: _input,
		outputSchema: _output,
		securitySchemes: _security,
		...config
	} = accountProfileTool;
	const tool = agent.server.registerTool(
		name,
		{
			...config,
			inputSchema: accountProfileInputSchema,
			outputSchema: accountProfileSchema,
		},
		async (args) => accountProfileResult(agent.callerIdentity, args),
	);
	agent.registeredTools.set(name, tool);
	if (
		agent.callerIdentity?.authType === "oauth" ||
		agent.callerIdentity?.authType === "user"
	)
		agent.authRequiredTools.add(name);
}
