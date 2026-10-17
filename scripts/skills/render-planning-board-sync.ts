/** Render reviewed, tenant-local skill assets. This command makes no live calls. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

const uuid = z.uuid();
const source = z.string().regex(/^collection:\/\/[a-f0-9-]{36}$/);
const field = z.string().min(1).max(100);
export const PlanningSyncConfigSchema = z
	.object({
		boardKey: z
			.string()
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.max(60),
		ownerTediId: uuid,
		decisionUserId: z.string().min(1).max(300),
		objectiveId: uuid,
		stateOutputId: uuid,
		reportOutputId: uuid,
		osBaseUrl: z.url().refine((value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				url.pathname === "/" &&
				!url.search &&
				!url.hash
			);
		}, "Expected a credential-free HTTPS origin"),
		provider: z.string().min(1).max(100).default("notion"),
		notionNamespace: z
			.string()
			.regex(/^[a-z][a-z0-9_]*$/)
			.max(80)
			.refine(
				(value) =>
					!["tedi", "tedix", "work", "constructor", "prototype"].includes(
						value,
					),
			)
			.default("notion"),
		projectsSource: source,
		tasksSource: source,
		meetingsSource: source,
		projectFields: z.object({
			name: field,
			status: field,
			due: field,
			start: field,
			type: field,
			next: field,
			tasks: field,
			meetings: field,
		}),
		taskFields: z.object({
			name: field,
			status: field,
			due: field,
			project: field,
		}),
		meetingFields: z.object({ name: field, date: field, project: field }),
		projectStatuses: z.record(
			z.string(),
			z.enum(["active", "paused", "archived", "done"]),
		),
		activeStatuses: z.array(field).min(1),
		exportProjectStatus: field,
		exportTaskStatus: field,
		projectLinks: z
			.record(z.string().regex(/^[a-f0-9]{32}$/), uuid)
			.default({}),
		exportProjectIds: z.array(uuid).default([]),
		mergeCandidates: z.array(z.string().min(1).max(1000)).max(20).default([]),
		exportSince: z.iso.datetime(),
		timeZone: z.string().refine((value) => {
			try {
				new Intl.DateTimeFormat("en", { timeZone: value });
				return true;
			} catch {
				return false;
			}
		}),
		workingDays: z.array(
			z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
		),
		workingHours: z.array(z.number().int().min(0).max(23)),
		nightlyHour: z.number().int().min(0).max(23),
		maxRows: z.number().int().min(100).max(10000).multipleOf(100).default(1000),
		signalWorkspaceIds: z.array(uuid).max(10).default([]),
		signalDays: z.number().int().min(1).max(30).default(7),
		maxSignalOutputs: z.number().int().min(1).max(10).default(3),
		signalReaders: z
			.array(
				z.object({
					label: field,
					namespace: z.literal("tedix"),
					method: z.literal("list_agent_session_activity"),
					sinceArgument: z.literal("since"),
					args: z.object({
						limit: z.number().int().min(1).max(100),
						requests: z
							.object({
								limit: z.number().int().min(1).max(200),
								order: z.literal("newest"),
							})
							.optional(),
					}),
				}),
			)
			.max(1)
			.default([]),
	})
	.strict()
	.superRefine((config, context) => {
		if (!config.projectStatuses[config.exportProjectStatus])
			context.addIssue({
				code: "custom",
				message: "Export status needs a project-status mapping",
			});
		if (
			[config.stateOutputId, config.reportOutputId].length !==
			new Set([config.stateOutputId, config.reportOutputId]).size
		)
			context.addIssue({
				code: "custom",
				message: "State and report must be separate Outputs",
			});
	});

export async function renderPlanningSync(input: unknown) {
	const config = PlanningSyncConfigSchema.parse(input);
	const directory = resolve(
		import.meta.dir,
		"../../apps/skill-runtime/examples/planning-board-sync",
	);
	const [document, workflow] = await Promise.all([
		readFile(`${directory}/SKILL.md`, "utf8"),
		readFile(`${directory}/scripts/workflow.ts`, "utf8"),
	]);
	const marker = "const CONFIG = /* PLANNING_SYNC_CONFIG */ {};";
	if (workflow.split(marker).length !== 2)
		throw new Error("Workflow configuration marker changed");
	const content = document
		.replace("name: planning-board-sync", `name: ${config.boardKey}`)
		.replace("    notion:", `    ${config.notionNamespace}:`);
	const manifest = parseCapabilityManifest(content);
	if (manifest.schedule?.enabled)
		throw new Error("Rendered skills must start with their schedule disabled");
	return {
		title: "Shared planning board sync",
		tediId: config.ownerTediId,
		content,
		files: {
			"scripts/workflow.ts": workflow.replace(
				marker,
				`const CONFIG = ${JSON.stringify(config)};`,
			),
		},
		visibility: "org",
		lifecycleState: "draft",
	};
}

if (import.meta.main) {
	const [configPath, destination] = process.argv.slice(2);
	if (!configPath || !destination)
		throw new Error(
			"Usage: bun scripts/skills/render-planning-board-sync.ts CONFIG.json OUTPUT.json",
		);
	await writeFile(
		destination,
		JSON.stringify(
			await renderPlanningSync(JSON.parse(await readFile(configPath, "utf8"))),
			null,
			2,
		),
	);
	console.log(`Rendered draft skill assets to ${destination}; no live writes.`);
}
