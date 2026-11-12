import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";
import { unstable_readConfig } from "wrangler";
import { parseInstallationManifest } from "./schema";
import { readWorkerSourceConfig } from "./worker-source-config";
import { workspaceInstallationManifest } from "./workspace-example";
import {
	createWranglerOverlay,
	renderWranglerSecretNames,
} from "./wrangler-overlay";

const root = resolve(import.meta.dirname, "../../..");

describe("workspace storage installation example", () => {
	test("declares the workspace owner and all three service callers", () => {
		const manifest = parseInstallationManifest(workspaceInstallationManifest);
		const owner = manifest.workers.find(
			(worker) => worker.id === "workspace-storage",
		);
		expect(owner?.sourceConfig).toBe("apps/workspace-do/wrangler.jsonc");
		expect(owner?.bindings).toContainEqual({
			kind: "durable-object",
			name: "WORKSPACE",
			resource: "workspace-state",
		});
		expect(
			manifest.resources.find((resource) => resource.id === "workspace-state"),
		).toMatchObject({
			kind: "durable-object",
			className: "WorkspaceDO",
			storage: "sqlite",
			scriptName: owner?.scriptName,
		});
		for (const id of ["control-api", "mcp-gateway", "os"]) {
			expect(
				manifest.workers.find((worker) => worker.id === id)?.bindings,
			).toContainEqual({
				kind: "service",
				name: "WORKSPACE_RUNTIME",
				resource: "workspace-service",
				entrypoint: "InternalEntrypoint",
			});
		}
	});

	test.each(workspaceInstallationManifest.workers)(
		"generates the tracked $id example without source coordinates",
		async (worker) => {
			const source = await readWorkerSourceConfig(
				resolve(root, worker.sourceConfig),
			);
			const result = createWranglerOverlay({
				manifest: workspaceInstallationManifest,
				sourceConfig: source,
				workerId: worker.id,
			});
			const directory = worker.sourceConfig.slice(
				0,
				worker.sourceConfig.lastIndexOf("/"),
			);
			const outputPath = resolve(root, directory, "wrangler.oss-example.json");
			expect(readFileSync(outputPath, "utf8")).toBe(result.text);
			expect(
				readFileSync(
					resolve(root, directory, "wrangler.oss-example.secrets.json"),
					"utf8",
				),
			).toBe(renderWranglerSecretNames(worker.id, result.requiredSecrets));
			expect(unstable_readConfig({ config: outputPath }).name).toBe(
				worker.scriptName.state === "resolved" ? worker.scriptName.value : "",
			);
			for (const marker of [
				"public-installation-",
				"configured-via-private-overlay",
				"tedix.dev",
				"tedi.club",
			]) {
				expect(result.text).not.toContain(marker);
			}
			expect(result.config.env).toBeUndefined();
			const authored = parse(source);
			expect(result.config.migrations).toEqual(authored.migrations);
			expect(result.config.worker_loaders).toEqual(authored.worker_loaders);
			if (worker.id === "workspace-storage") {
				expect(result.config.migrations).toEqual([
					{ tag: "v1", new_sqlite_classes: ["WorkspaceDO"] },
				]);
				expect(result.config.worker_loaders).toEqual([{ binding: "LOADER" }]);
				expect(result.config.durable_objects).toEqual({
					bindings: [
						{
							name: "TEDI_AGENT",
							class_name: "AgentTediDO",
							script_name: "acme-tedi-runtime",
						},
						{ name: "WORKSPACE", class_name: "WorkspaceDO" },
					],
				});
				expect(result.config.r2_buckets).toEqual([
					{ binding: "R2_BUCKET", bucket_name: "acme-developer-artifacts" },
				]);
				expect(result.config.services).toEqual([
					{ binding: "MCP_SERVICE", service: "acme-mcp" },
				]);
				expect(result.config.vars).toMatchObject({ DO_JURISDICTION: "" });
				expect(result.requiredSecrets).toContain("MIGRATE_WORKSPACES_TOKEN");
			} else {
				expect(result.config.services).toContainEqual({
					binding: "WORKSPACE_RUNTIME",
					service: "acme-workspace-storage",
					entrypoint: "InternalEntrypoint",
				});
				expect(authored.services).toContainEqual(
					expect.objectContaining({
						binding: "WORKSPACE_RUNTIME",
						entrypoint: "InternalEntrypoint",
					}),
				);
			}
		},
	);

	test("keeps EU R2 jurisdiction explicitly unsupported instead of dropping it", () => {
		const input = structuredClone(workspaceInstallationManifest);
		const bucket = input.resources.find(
			(resource) => resource.id === "artifact-bucket",
		);
		expect(() =>
			parseInstallationManifest({
				...input,
				resources: input.resources.map((resource) =>
					resource === bucket ? { ...resource, jurisdiction: "eu" } : resource,
				),
			}),
		).toThrow();
	});
});
