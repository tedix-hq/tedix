import { expect, it } from "vite-plus/test";
import { agentReviewProjectId } from "./agent-review-config";

it("disables intake in local mode without weakening deployed privacy policy", () => {
	const env = {
		ENVIRONMENT: "development",
		DESCOPE_PROJECT_ID: "local-development-disabled",
		AGENT_REVIEW_PROJECT_ID: "configured-via-private-overlay",
	} as CloudflareEnv;
	expect(agentReviewProjectId(env)).toBeUndefined();
	expect(agentReviewProjectId({ ...env, ENVIRONMENT: "production" })).toBe(
		env.AGENT_REVIEW_PROJECT_ID,
	);
	expect(
		agentReviewProjectId({ ...env, DESCOPE_PROJECT_ID: "real-auth-project" }),
	).toBe(env.AGENT_REVIEW_PROJECT_ID);
});
