#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelCatalogConfigSchema } from "@tedix/api-contract/schemas/model-catalog-config";
import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import blueprint from "../apps/os/dev/demo-pack/work-blueprint.json";

/** The Workers AI model local chat uses when `bun run-local --inference` is on. */
export const LOCAL_WORKERS_AI_MODEL_REF =
	"workers-ai/@cf/moonshotai/kimi-k2.7-code";

/** A one-model catalog, so local chat can route and answer through Workers AI. */
export function localModelCatalog() {
	const [provider, ...rest] = LOCAL_WORKERS_AI_MODEL_REF.split("/");
	return ModelCatalogConfigSchema.parse({
		version: 1,
		entries: [
			{
				ref: LOCAL_WORKERS_AI_MODEL_REF,
				provider,
				modelId: rest.join("/"),
				label: "Kimi K2.7 Code",
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
		],
		fallback: { version: 1, maxTransitions: 0, ladder: {} },
		defaults: {
			kernelRouteModelRef: LOCAL_WORKERS_AI_MODEL_REF,
			workersAiModelRef: LOCAL_WORKERS_AI_MODEL_REF,
		},
	});
}

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
		(options.workersAi
			? systemPack("model-catalog", "Local model catalog", {
					modelCatalog: localModelCatalog(),
				})
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
