import {
	appRuntimeCodeLength,
	isAppRuntimeManifest,
} from "@tedix/api-contract/utils/app-runtime";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	BlueprintProvisioningSchema,
	type BlueprintApplyReceipt,
} from "@tedix/api-contract/schemas/blueprint-provisioning";
import {
	OsBlueprintDefinitionSchema,
	type OsBlueprintDefinition,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { BlueprintProvisioningRows } from "@tedix/db/queries/os-workspaces/provisioning";
import type { InstantiateOsBlueprintParams } from "@tedix/db/queries/os-workspaces/instantiate";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { canonicalDigest } from "../lib/blueprint-digest";

interface BlueprintPlanInput {
	organizationId: string;
	blueprintId: string;
	revisionId: string;
	instanceKey: string;
	workspaceName: string;
	parameters: Record<string, JsonValue>;
	definition: OsBlueprintDefinition;
}

/** UUID-shaped deterministic identities, scoped to tenant, blueprint and instance. */
async function blueprintInstanceId(parts: string[]): Promise<string> {
	const digest = await canonicalDigest(parts);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function substitute(
	value: unknown,
	parameters: Record<string, JsonValue>,
): unknown {
	if (typeof value === "string")
		return value.replace(
			/\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g,
			(_, name: string) => {
				if (!Object.hasOwn(parameters, name))
					throw new Error(`Missing blueprint parameter: ${name}`);
				const replacement = parameters[name];
				return typeof replacement === "string"
					? replacement
					: JSON.stringify(replacement);
			},
		);
	if (Array.isArray(value))
		return value.map((item) => substitute(item, parameters));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				substitute(nested, parameters),
			]),
		);
	return value;
}

export async function planBlueprintApply(input: BlueprintPlanInput) {
	const declared = input.definition.provisioning;
	if (!declared)
		throw new Error("Blueprint has no structured provisioning declaration");
	for (const [name, spec] of Object.entries(declared.parameters)) {
		const value = input.parameters[name];
		if (value === undefined) {
			if (spec.required)
				throw new Error(`Missing blueprint parameter: ${name}`);
			continue;
		}
		const type = Array.isArray(value)
			? "array"
			: value === null
				? "null"
				: typeof value;
		if (type !== spec.type)
			throw new Error(`Blueprint parameter ${name} must be ${spec.type}`);
		if (typeof value === "string" && !value.trim())
			throw new Error(`Blueprint parameter ${name} must not be empty`);
	}
	for (const name of Object.keys(input.parameters))
		if (!Object.hasOwn(declared.parameters, name))
			throw new Error(`Unknown blueprint parameter: ${name}`);
	const prefix = [input.organizationId, input.blueprintId, input.instanceKey];
	const workspaceId = await blueprintInstanceId([...prefix, "workspace"]);
	const projectId = declared.project
		? await blueprintInstanceId([...prefix, "project", declared.project.key])
		: undefined;
	const bound = {
		...input.parameters,
		workspaceId,
		...(projectId ? { projectId } : {}),
	};
	const definition = OsBlueprintDefinitionSchema.parse(
		substitute(input.definition, bound),
	);
	const provisioning = BlueprintProvisioningSchema.parse(
		definition.provisioning,
	);
	for (const row of [provisioning.project, ...provisioning.milestones]) {
		if (!row || !row.targetAt || typeof row.targetAt === "string") continue;
		const source = input.parameters[row.targetAt.parameter];
		if (
			typeof source !== "string" ||
			!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(source) ||
			!Number.isFinite(Date.parse(source))
		)
			throw new Error(`Invalid date parameter: ${row.targetAt.parameter}`);
		row.targetAt = new Date(
			Date.parse(source) + row.targetAt.offsetMinutes * 60_000,
		).toISOString();
	}
	definition.provisioning = provisioning;
	for (const date of [
		provisioning.project?.targetAt,
		...provisioning.milestones.map((row) => row.targetAt),
	]) {
		if (
			typeof date === "string" &&
			(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(date) ||
				!Number.isFinite(Date.parse(date)))
		)
			throw new Error(
				`Blueprint target must be a timezone-aware date: ${date}`,
			);
	}
	for (const schedule of provisioning.schedules) {
		nextSkillScheduleFireAt(schedule.cron, Date.now());
		if (schedule.enabled && !schedule.skillId)
			throw new Error(
				`Enabled schedule ${schedule.key} requires a governed executable skill binding`,
			);
	}
	const names = definition.gadgets.map((app) => app.name);
	if (new Set(names).size !== names.length)
		throw new Error("Blueprint app names must be unique");
	const planSha256 = await canonicalDigest({
		revisionId: input.revisionId,
		workspaceName: input.workspaceName,
		definition,
		parameters: input.parameters,
	});
	const resources: BlueprintApplyReceipt["resources"] = [];
	async function add(
		kind: BlueprintApplyReceipt["resources"][number]["kind"],
		key: string,
	) {
		resources.push({
			kind,
			key,
			id: await blueprintInstanceId([...prefix, kind, key]),
		});
	}
	if (provisioning.project) await add("project", provisioning.project.key);
	for (const row of provisioning.milestones) await add("milestone", row.key);
	for (const row of provisioning.workItems) {
		await add("work_item", row.key);
		for (const dependency of row.dependsOn)
			await add("dependency", `${row.key}:${dependency}`);
	}
	for (const row of provisioning.documents) await add("document", row.key);
	for (const row of provisioning.schedules) await add("schedule", row.key);
	for (const row of definition.gadgets) await add("app", row.name);
	const receipt: BlueprintApplyReceipt = {
		workspaceId,
		revisionId: input.revisionId,
		instanceKey: input.instanceKey,
		planSha256,
		replayed: false,
		resources,
	};
	return { definition: { ...definition, provisioning }, receipt };
}
export type BlueprintApplyPlan = Awaited<ReturnType<typeof planBlueprintApply>>;

/** Preview and apply share this plan; only audit timestamps and creators are added here. */
export async function buildBlueprintApplyRows(
	plan: BlueprintApplyPlan,
	base: {
		organizationId: string;
		blueprintId: string;
		revision: number;
		workspaceName: string;
		createdByKind: "user" | "tedi" | "external_agent" | "service";
		createdById: string;
		now: string;
		preflight: string;
	},
): Promise<InstantiateOsBlueprintParams> {
	const { receipt, definition } = plan;
	const p = definition.provisioning;
	const { workspaceId, revisionId } = receipt;
	const id = (
		kind: BlueprintApplyReceipt["resources"][number]["kind"],
		key: string,
	) => {
		const row = receipt.resources.find(
			(row) => row.kind === kind && row.key === key,
		);
		if (!row) throw new Error(`Missing planned ${kind}: ${key}`);
		return row.id;
	};
	const creator = {
		organizationId: base.organizationId,
		createdByKind: base.createdByKind,
		createdById: base.createdById,
		createdAt: base.now,
	};
	const provenance = (key: string) => ({
		blueprintRevisionId: revisionId,
		blueprintInstanceKey: receipt.instanceKey,
		templateKey: key,
	});
	const rows: BlueprintProvisioningRows = {
		projects: [],
		milestones: [],
		items: [],
		relations: [],
		milestoneItems: [],
		outputs: [],
		outputRevisions: [],
		projectLinks: [],
		schedules: [],
	};
	const params: InstantiateOsBlueprintParams = {
		workspace: {
			...creator,
			id: workspaceId,
			name: base.workspaceName,
			status: "active",
			sourceBlueprintId: base.blueprintId,
			sourceBlueprintRevisionId: revisionId,
			sourceBlueprintRevisionNumber: base.revision,
			instantiationPreflight: base.preflight,
			updatedAt: base.now,
		},
		gadgets: [],
		revisions: [],
		code: [],
		resources: [],
		provisioning: rows,
	};
	const projectId = p.project ? id("project", p.project.key) : null;
	if (p.project && projectId) {
		rows.projects.push({
			id: projectId,
			orgId: base.organizationId,
			key: `${p.project.key.slice(0, 7)}-${projectId.replaceAll("-", "")}`,
			name: p.project.name,
			description: p.project.description,
			targetDate:
				typeof p.project.targetAt === "string" ? p.project.targetAt : undefined,
			metadata: provenance(p.project.key),
			createdAt: base.now,
			updatedAt: base.now,
		});
		rows.projectLinks.push({
			...creator,
			id: await blueprintInstanceId([workspaceId, "project-link"]),
			workspaceId,
			projectId,
			updatedAt: base.now,
		});
	}
	for (const [index, milestone] of p.milestones.entries())
		rows.milestones.push({
			id: id("milestone", milestone.key),
			orgId: base.organizationId,
			projectId: projectId!,
			title: milestone.title,
			description: milestone.description,
			targetAt:
				typeof milestone.targetAt === "string" ? milestone.targetAt : undefined,
			sortOrder: index,
			accountableOwnerType: "system",
			accountableOwnerId: `blueprint:${workspaceId}`,
			metadata: provenance(milestone.key),
			createdAt: base.now,
		});
	for (const item of p.workItems) {
		const workItemId = id("work_item", item.key);
		rows.items.push({
			id: workItemId,
			orgId: base.organizationId,
			projectId,
			title: item.title,
			description: item.description,
			disposition: "proposed",
			workKind: item.workKind,
			riskLevel: item.riskLevel,
			acceptanceContract: { version: 1, doneLooksLike: item.doneWhen },
			provenance: provenance(item.key),
			metadata: {
				...provenance(item.key),
				suggestedOwners: item.suggestedOwners,
			},
			createdAt: base.now,
		});
		for (const dependency of item.dependsOn)
			rows.relations.push({
				id: id("dependency", `${item.key}:${dependency}`),
				orgId: base.organizationId,
				fromWorkItemId: id("work_item", dependency),
				toWorkItemId: workItemId,
				relationType: "blocks",
				metadata: provenance(`${item.key}:${dependency}`),
				createdAt: base.now,
			});
		if (item.milestone)
			rows.milestoneItems.push({
				orgId: base.organizationId,
				milestoneId: id("milestone", item.milestone),
				workItemId,
				createdAt: base.now,
			});
	}
	for (const doc of p.documents) {
		const outputId = id("document", doc.key),
			outputRevisionId = await blueprintInstanceId([outputId, "revision", "1"]);
		rows.outputs.push({
			...creator,
			id: outputId,
			workspaceId,
			kind: "document",
			title: doc.title,
			currentRevisionId: outputRevisionId,
			updatedAt: base.now,
		});
		rows.outputRevisions.push({
			...creator,
			id: outputRevisionId,
			outputId,
			revision: 1,
			content: JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: doc.text }],
			}),
			note: `Blueprint template: ${doc.key}`,
		});
	}
	for (const app of definition.gadgets) {
		const gadgetId = id("app", app.name),
			appRevisionId = await blueprintInstanceId([gadgetId, "revision", "1"]);
		if (isAppRuntimeManifest(app.manifest)) {
			if (!app.files)
				throw new Error(`Runtime app ${app.name} has no source files`);
			params.code!.push({
				organizationId: base.organizationId,
				gadgetId,
				revisionId: appRevisionId,
				files: JSON.stringify(app.files),
				codeLength: appRuntimeCodeLength(app.files),
				createdAt: base.now,
			});
		}
		params.gadgets.push({
			...creator,
			id: gadgetId,
			workspaceId,
			name: app.name,
			currentRevisionId: appRevisionId,
			sourceBlueprintRevisionId: revisionId,
			updatedAt: base.now,
		});
		params.revisions.push({
			...creator,
			id: appRevisionId,
			gadgetId,
			revision: 1,
			manifest: JSON.stringify(app.manifest),
		});
	}
	for (const schedule of p.schedules)
		params.resources!.push({
			...creator,
			id: id("schedule", schedule.key),
			workspaceId,
			slot: `blueprint-schedule:${schedule.key}`,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "schedule_definition",
			providerResourceId: schedule.skillId ?? id("schedule", schedule.key),
			name: schedule.name,
			metadata: JSON.stringify({
				...schedule,
				...provenance(schedule.key),
				runtimeStatus: schedule.skillId ? "bound" : "unbound",
			}),
			updatedAt: base.now,
		});
	params.resources!.push({
		...creator,
		id: await blueprintInstanceId([workspaceId, "receipt"]),
		workspaceId,
		slot: "blueprint-apply-receipt",
		providerId: "tedix",
		connectionScope: "tenant",
		resourceType: "blueprint_apply",
		providerResourceId: workspaceId,
		name: "Blueprint apply receipt",
		metadata: JSON.stringify(receipt),
		updatedAt: base.now,
	});
	return params;
}
