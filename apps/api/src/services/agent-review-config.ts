import { isLocalDemoProject } from "@tedix/auth/local-demo";

/** Local onboarding has no private review project or intake. */
export function agentReviewProjectId(env: CloudflareEnv): string | undefined {
	if (
		env.ENVIRONMENT === "development" &&
		isLocalDemoProject(env.DESCOPE_PROJECT_ID)
	)
		return undefined;
	return env.AGENT_REVIEW_PROJECT_ID || undefined;
}
