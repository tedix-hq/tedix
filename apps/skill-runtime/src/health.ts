import type { SkillRuntimeEnv } from "./env";

export function skillRuntimeHealth(
	env: Pick<SkillRuntimeEnv, "ENVIRONMENT" | "GIT_SHA" | "WORKER_VERSION">,
) {
	return {
		ok: true,
		service: "skill-runtime",
		env: env.ENVIRONMENT,
		deployedSha: env.GIT_SHA,
		workerVersion: {
			id: env.WORKER_VERSION.id,
			tag: env.WORKER_VERSION.tag,
			timestamp: env.WORKER_VERSION.timestamp,
		},
	};
}
