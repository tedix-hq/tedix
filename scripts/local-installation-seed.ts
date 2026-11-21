#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelCatalogConfigSchema } from "@tedix/api-contract/schemas/model-catalog-config";
import {
	RUNNER_RULES_SLUG,
	RunnerRulesSchema,
} from "@tedix/api-contract/schemas/runner-rules";
import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import blueprint from "../apps/os/dev/demo-pack/work-blueprint.json";
import { LOCAL_WORKERS_AI_MODEL } from "./lib/local-workers-ai-model";

export const LOCAL_WORKERS_AI_MODEL_REF = `workers-ai/${LOCAL_WORKERS_AI_MODEL}`;

/**
 * A small catalog, so local chat can route and answer through Workers AI and
 * workspace chat can compare a second model.
 */
export function localModelCatalog() {
	return ModelCatalogConfigSchema.parse({
		version: 1,
		entries: [
			{
				ref: LOCAL_WORKERS_AI_MODEL_REF,
				provider: "workers-ai",
				modelId: LOCAL_WORKERS_AI_MODEL,
				label: "GLM 5.3",
				reasoning: true,
				tier: "balanced",
				imageInput: "unsupported",
				governance: {
					weightAccess: "open-weights",
					residencyControl: "cloudflare-network",
					routingMode: "fixed",
				},
				lifecycle: "active",
				maxOutputTokens: 128_000,
				reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
			},
			{
				ref: "workers-ai/@cf/openai/gpt-oss-120b",
				provider: "workers-ai",
				modelId: "@cf/openai/gpt-oss-120b",
				label: "GPT OSS 120B",
				reasoning: true,
				tier: "balanced",
				imageInput: "unsupported",
				governance: {
					weightAccess: "open-weights",
					residencyControl: "cloudflare-network",
					routingMode: "fixed",
				},
				lifecycle: "active",
				reasoningEfforts: ["low", "medium", "high"],
			},
		],
		fallback: { version: 1, maxTransitions: 0, ladder: {} },
		defaults: {
			kernelRouteModelRef: LOCAL_WORKERS_AI_MODEL_REF,
			workersAiModelRef: LOCAL_WORKERS_AI_MODEL_REF,
		},
	});
}

/** What every local runner tells a run before its first turn. */
const LOCAL_RUNNER_RULES = `## Runner ownership
The runner reads these rules from Tedix before each launch. Your session has its own verified agent identity and an admitted Work Attempt before its first model turn. Keep the supplied Work and Attempt identity. The runner owns heartbeats, telemetry and Attempt settlement; do not start, settle or complete a second Attempt.

Never automate human consent, MFA, user presence, or impersonation. A task note does not override provider permissions or admission. A bounded owner delegation can authorize only its stated action. Keep the final result and evidence in the matching Tedix OS Work; local files are working buffers.`;

const q = (value: string) => `'${value.replaceAll("'", "''")}'`;

function systemPack(slug: string, name: string, definition: unknown) {
	return `INSERT INTO policy_packs (id,organization_id,name,slug,scope,target,status,version,published_at,published_by,definition)
 SELECT ${q(crypto.randomUUID())},NULL,${q(name)},${q(slug)},'system','shared','active',1,${q(new Date().toISOString())},'local-development',${q(JSON.stringify(definition))}
 WHERE NOT EXISTS (SELECT 1 FROM policy_packs WHERE scope='system' AND slug=${q(slug)});\n`;
}

/**
 * Local installation setup only; never replaces an operator's existing
 * publication. With Workers AI on, it also publishes a model catalog: without
 * one every chat turn fails because no model is configured.
 */
export function localInstallationSeedSql(
	options: { workersAi?: boolean } = {},
) {
	const workOnboarding = WorkOnboardingSchema.parse({
		version: 1,
		definition: blueprint,
	});
	return (
		systemPack("work-onboarding", "Local Work onboarding", { workOnboarding }) +
		systemPack(RUNNER_RULES_SLUG, "Local runner rules", {
			runnerRules: RunnerRulesSchema.parse({ content: LOCAL_RUNNER_RULES }),
		}) +
		(options.workersAi
			? systemPack("model-catalog", "Local model catalog", {
					modelCatalog: localModelCatalog(),
				}) +
				// Keep the launcher's own catalog on the current local model, so a
				// retired model does not leave an existing install without chat.
				`UPDATE policy_packs SET definition=${q(JSON.stringify({ modelCatalog: localModelCatalog() }))}
 WHERE scope='system' AND slug='model-catalog' AND published_by='local-development' AND name='Local model catalog';\n`
			: "")
	);
}

if (import.meta.main) {
	const directory = mkdtempSync(join(tmpdir(), "tedix-local-installation-"));
	const file = join(directory, "seed.sql");
	try {
		writeFileSync(
			file,
			localInstallationSeedSql({
				workersAi: process.env.TEDIX_LOCAL_INFERENCE_BACKEND === "workers-ai",
			}),
		);
		const run = spawnSync(
			"bun",
			[
				"../../scripts/dev-local.ts",
				"--",
				"wrangler",
				"d1",
				"execute",
				"DB",
				"--file",
				file,
			],
			{ cwd: resolve(import.meta.dirname, "../apps/api"), stdio: "inherit" },
		);
		if (run.status !== 0) process.exitCode = run.status ?? 1;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
