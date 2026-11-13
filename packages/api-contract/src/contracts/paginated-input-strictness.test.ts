import { describe, expect, test } from "vite-plus/test";
import { appToolsContract } from "./app-tools";
import { appsContract } from "./apps";
import { auditContract } from "./audit";
import { capabilitiesContract } from "./capabilities";
import { directoryContract } from "./directory";
import { growthSnapshotsContract } from "./growth-snapshots";
import { jobsContract } from "./jobs";
import { organizationsContract } from "./organizations";
import { projectsContract } from "./projects";
import { rationaleRecordsContract } from "./rationale-records";
import { roleTemplatesContract } from "./role-templates";
import { tediApprovalsContract } from "./tedi-approvals";
import { tediObjectivesContract } from "./tedi-objectives";
import { tedisContract } from "./tedis";
import { templatesContract } from "./templates";

const id = "00000000-0000-4000-8000-000000000001";
const cases = [
	{
		name: "app tools",
		procedure: appToolsContract.list,
		input: { appId: id, query: "search" },
	},
	{ name: "apps", procedure: appsContract.list, input: { organizationId: id } },
	{
		name: "audit",
		procedure: auditContract.search,
		input: { action: "example.read" },
	},
	{
		name: "capabilities",
		procedure: capabilitiesContract.list,
		input: { status: "active" },
	},
	{
		name: "directory",
		procedure: directoryContract.listMyWorkspaces,
		input: {},
	},
	{
		name: "growth snapshots",
		procedure: growthSnapshotsContract.list,
		input: { tediId: id },
	},
	{
		name: "jobs",
		procedure: jobsContract.listJobs,
		input: { appId: id, status: "running" },
	},
	{ name: "organizations", procedure: organizationsContract.list, input: {} },
	{
		name: "my organizations",
		procedure: organizationsContract.listMine,
		input: { activeOnly: false },
	},
	{
		name: "all my organizations",
		procedure: organizationsContract.listAllMine,
		input: { activeOnly: false },
	},
	{
		name: "OS organizations",
		procedure: organizationsContract.listOsMine,
		input: {},
	},
	{
		name: "API keys",
		procedure: organizationsContract.listApiKeys,
		input: { organizationId: id },
	},
	{
		name: "projects",
		procedure: projectsContract.list,
		input: { search: "example" },
	},
	{
		name: "rationale",
		procedure: rationaleRecordsContract.list,
		input: { tediId: id },
	},
	{
		name: "role templates",
		procedure: roleTemplatesContract.list,
		input: { includeArchived: true },
	},
	{
		name: "approvals",
		procedure: tediApprovalsContract.list,
		input: { decidableOnly: true },
	},
	{
		name: "objectives",
		procedure: tediObjectivesContract.list,
		input: { tediId: id },
	},
	{
		name: "tasks",
		procedure: tediObjectivesContract.listTasks,
		input: { objectiveId: id },
	},
	{
		name: "tedis",
		procedure: tedisContract.list,
		input: { search: "example", includeRetired: true },
	},
	{ name: "templates", procedure: templatesContract.list, input: {} },
	{
		name: "backup audit",
		procedure: tedisContract.auditBackups,
		input: { maxBackupAgeHours: 24, includeR2: true },
	},
];

describe.each(cases)("$name pagination input", ({ procedure, input }) => {
	const schema = procedure["~orpc"].inputSchemas[0]!;

	test("keeps declared filters, defaults and query-string number coercion", () => {
		expect(schema.parse(input)).toMatchObject({
			...input,
			limit: 50,
			offset: 0,
		});
		expect(schema.parse({ ...input, limit: "25", offset: "10" })).toMatchObject(
			{ ...input, limit: 25, offset: 10 },
		);
	});

	test("rejects an undeclared filter instead of returning a broader page", () => {
		const result = schema.safeParse({ ...input, undeclaredFilter: "narrow" });
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.issues).toContainEqual(
				expect.objectContaining({
					code: "unrecognized_keys",
					keys: ["undeclaredFilter"],
				}),
			);
	});

	test("keeps pagination bounds", () => {
		expect(schema.safeParse({ ...input, limit: 0 }).success).toBe(false);
		const maxLimit = procedure === appToolsContract.list ? 500 : 100;
		expect(schema.safeParse({ ...input, limit: maxLimit + 1 }).success).toBe(
			false,
		);
		expect(schema.safeParse({ ...input, offset: -1 }).success).toBe(false);
	});
});

test("optional collection inputs still accept omission", () => {
	for (const procedure of [
		appsContract.list,
		auditContract.search,
		capabilitiesContract.list,
		projectsContract.list,
		rationaleRecordsContract.list,
		roleTemplatesContract.list,
		tediApprovalsContract.list,
		tediObjectivesContract.list,
		tediObjectivesContract.listTasks,
		tedisContract.list,
		tedisContract.auditBackups,
	]) {
		expect(
			procedure["~orpc"].inputSchemas[0]!.parse(undefined),
		).toBeUndefined();
	}
});

test("app-tool inventory keeps its larger page size", () => {
	expect(
		appToolsContract.list["~orpc"].inputSchemas[0]!.parse({
			appId: id,
			limit: 500,
		}).limit,
	).toBe(500);
});
