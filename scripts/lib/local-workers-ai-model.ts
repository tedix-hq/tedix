/**
 * The Workers AI model a local run uses when `bun run-local --inference` is
 * on: Home chat and the default of workspace chat and the local catalog.
 */
export const LOCAL_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.3";

/** Workspace chat offers these locally, so runs can compare models. */
export const LOCAL_WORKSPACE_WORKERS_AI_MODELS = [
	LOCAL_WORKERS_AI_MODEL,
	"@cf/openai/gpt-oss-120b",
];
