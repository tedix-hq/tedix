import { describe, expect, mock, test } from "bun:test";
import {
	publishMigratedToolMetadata,
	toolPublicationTarget,
} from "./publish-migrated-tool-metadata";
import type { runWrangler } from "../../packages/db/scripts/wrangler-command";

const databaseId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const name = "next/migration.sql";
const dbConfig = JSON.stringify({
	d1_databases: [{ binding: "DB", database_id: databaseId }],
});
function apiConfig(id = databaseId) {
	return JSON.stringify({
		env: {
			production: {
				d1_databases: [{ binding: "DB", database_id: id }],
				workflows: [
					{
						binding: "TOOL_SCHEMA_SYNC_WORKFLOW",
						class_name: "ToolSchemaSyncWorkflow",
						name: "fixture-schema-sync",
					},
				],
			},
		},
	});
}

function fixture() {
	let clock = 0;
	const proof = {
		publicationProtocol: 1,
		schemaWrites: 0,
		published: true,
		activationEpoch: "epoch-fresh",
		migration: { id: 7, name },
	};
	const response = {
		id: instanceId,
		status: "complete",
		success: true,
		error: null,
		steps: [
			{
				name: "publish migrated tool metadata-1",
				success: true,
				type: "step",
				output: JSON.stringify(proof),
			},
		],
	};
	const run = mock(
		(args: string[], _options?: Parameters<typeof runWrangler>[1]) => {
			if (args[0] === "d1")
				return JSON.stringify([
					{
						success: true,
						results: [{ id: 7, name, applied_at: "2026-01-01 00:00:00" }],
					},
				]);
			if (args[1] === "trigger")
				return `Workflow instance "${instanceId}" has been queued`;
			return JSON.stringify(response);
		},
	);
	return {
		run,
		proof,
		response,
		options: {
			run,
			readConfig: (path: string) =>
				path.includes("/apps/api/") ? apiConfig() : dbConfig,
			now: () => clock,
			wallNow: () => Date.parse("2026-01-01T00:00:05Z") + clock,
			wait: (ms: number) => {
				clock += ms;
			},
		},
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("migration publication", () => {
	test("resolves only matching explicit installation bindings", () => {
		expect(toolPublicationTarget(dbConfig, apiConfig())).toEqual({
			workflowName: "fixture-schema-sync",
		});
		expect(() =>
			toolPublicationTarget(
				dbConfig,
				apiConfig("33333333-3333-4333-8333-333333333333"),
			),
		).toThrow("same explicit installation");
		expect(() => toolPublicationTarget("{}", apiConfig())).toThrow(
			"same explicit installation",
		);
		expect(() => toolPublicationTarget("{", apiConfig())).toThrow(
			"Invalid publication configuration",
		);
	});

	test("uses the existing workflow with a legacy-safe payload and verifies the exact migration", () => {
		const f = fixture();
		expect(publishMigratedToolMetadata(name, true, f.options)).toEqual({
			instanceId,
			activationEpoch: "epoch-fresh",
		});
		const trigger = f.run.mock.calls.find(([args]) => args[1] === "trigger")!;
		expect(JSON.parse(trigger[0][3]!)).toEqual({
			kind: "publish_tool_metadata",
			mode: "schema",
			apply: false,
			expectedMigration: { id: 7, name },
		});
		expect(
			f.run.mock.calls.every(
				([, options]) => (options?.timeoutMs ?? Infinity) <= 15_000,
			),
		).toBe(true);
		expect(f.run.mock.calls[0]![0]).toContain("--remote");
	});

	test("refuses an old workflow preview instead of interpreting it as publication", () => {
		const f = fixture();
		f.response.steps = [
			{
				name: "plan tool schema sync-1",
				success: true,
				type: "step",
				output: "{}",
			},
		];
		expect(() => publishMigratedToolMetadata(name, false, f.options)).toThrow(
			"publication-only protocol",
		);
	});

	test.each(["epoch", "migration", "schema"])(
		"refuses a malformed %s acknowledgment",
		(field) => {
			const f = fixture();
			if (field === "epoch") f.proof.activationEpoch = "";
			if (field === "migration") f.proof.migration.id = 8;
			if (field === "schema") f.proof.schemaWrites = 1;
			f.response.steps[0]!.output = JSON.stringify(f.proof);
			expect(() => publishMigratedToolMetadata(name, true, f.options)).toThrow(
				"publication-only protocol",
			);
		},
	);

	test("checks the earliest migration timestamp and still activates a late migration before rejecting its timing", () => {
		const f = fixture();
		f.advance(60_000);
		expect(() =>
			publishMigratedToolMetadata(name, true, {
				...f.options,
				firstMigration: "first/migration.sql",
			}),
		).toThrow("one-minute window");
		expect(f.run.mock.calls[0]![0].join(" ")).toContain(
			"WHERE name = 'first/migration.sql'",
		);
		expect(f.run.mock.calls.some(([args]) => args[1] === "instances")).toBe(
			true,
		);
	});

	test("enforces the execution deadline without retrying an ambiguous trigger", () => {
		const f = fixture();
		f.response.status = "running";
		f.options.wait = () => f.advance(45_000);
		expect(() => publishMigratedToolMetadata(name, true, f.options)).toThrow(
			"deadline exceeded",
		);
		expect(
			f.run.mock.calls.filter(([args]) => args[1] === "trigger"),
		).toHaveLength(1);
	});
});
