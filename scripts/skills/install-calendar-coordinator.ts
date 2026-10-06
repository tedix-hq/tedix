/** Canonical asset installation only. Default execution is local and read-only. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { getApiClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { z } from "zod";
import type { OsBlueprintResourceRequirementSchema } from "@tedix/api-contract/schemas/os-workspaces";
type OsBlueprintResourceRequirement = z.infer<
	typeof OsBlueprintResourceRequirementSchema
>;
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

type ApiClient = ReturnType<typeof getApiClient<ApiContract>>;
export type InstallerClient = Pick<
	ApiClient,
	"tedis" | "connections" | "apps" | "skills" | "osWorkspaces"
>;
export type Assets = { content: string; workflow: string };
export type InstallOptions = {
	apiUrl: string;
	organizationId: string;
	workerId: string;
	slug: string;
	apply: boolean;
	reviewed: boolean;
	reviewReason: string;
	googleProvider?: string;
	googleCalendars: number;
	outlookProvider?: string;
	outlookCalendars: number;
};
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOOGLE_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_LIST =
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const GOOGLE_ROOT = "https://www.googleapis.com/auth/calendar";
const METHOD = "reconcile_calendar_subscription";
const USAGE =
	"bun scripts/skills/install-calendar-coordinator.ts --api-url https://api.tedix.dev --organization UUID --worker UUID --google-provider ID --google-calendars N [--outlook-provider ID --outlook-calendars N] [--apply --reviewed --review-reason TEXT]";
export function parseOptions(argv: string[]): InstallOptions {
	const values = new Map<string, string>();
	const switches = new Set<string>();
	const allowed = new Set([
		"--api-url",
		"--organization",
		"--worker",
		"--slug",
		"--google-provider",
		"--google-calendars",
		"--outlook-provider",
		"--outlook-calendars",
		"--review-reason",
	]);
	for (let index = 0; index < argv.length; index++) {
		const name = argv[index]!;
		if (values.has(name) || switches.has(name))
			throw new Error(`Duplicate argument: ${name}`);
		if (name === "--apply" || name === "--reviewed") switches.add(name);
		else {
			if (!allowed.has(name))
				throw new Error(`Unknown argument: ${name}. ${USAGE}`);
			const value = argv[++index];
			if (!value || value.startsWith("--"))
				throw new Error(`Missing value for ${name}`);
			values.set(name, value);
		}
	}
	const required = (key: string) => {
		const value = values.get(key);
		if (!value) throw new Error(`Required: ${key}. ${USAGE}`);
		return value;
	};
	const api = new URL(required("--api-url"));
	if (
		api.protocol !== "https:" ||
		api.username ||
		api.password ||
		api.search ||
		api.hash ||
		api.pathname !== "/"
	)
		throw new Error(
			"API URL must be an explicit HTTPS origin without credentials, query or path",
		);
	const organizationId = required("--organization");
	const workerId = required("--worker");
	if (!UUID.test(organizationId) || !UUID.test(workerId))
		throw new Error("Organization and worker must be UUIDs");
	const count = (key: string) => {
		const value = values.get(key) ?? "0";
		if (!/^\d+$/.test(value) || Number(value) > 20)
			throw new Error(`${key} must be an integer from 0 to 20`);
		return Number(value);
	};
	const googleCalendars = count("--google-calendars");
	const outlookCalendars = count("--outlook-calendars");
	const googleProvider = values.get("--google-provider");
	const outlookProvider = values.get("--outlook-provider");
	if (
		Boolean(googleProvider) !== Boolean(googleCalendars) ||
		Boolean(outlookProvider) !== Boolean(outlookCalendars)
	)
		throw new Error(
			"Each provider needs its calendar count, and each nonzero count needs its provider ID",
		);
	if (
		googleCalendars + outlookCalendars < 2 ||
		googleCalendars + outlookCalendars > 20
	)
		throw new Error("Select between 2 and 20 calendar slots");
	if (googleProvider && googleProvider === outlookProvider)
		throw new Error("Google and Outlook must use distinct provider IDs");
	for (const provider of [googleProvider, outlookProvider])
		if (provider && (provider.length > 160 || !provider.trim()))
			throw new Error(
				"Provider ID must be nonempty and at most 160 characters",
			);
	const slug =
		values.get("--slug") ?? `calendar-coordinator-${workerId.toLowerCase()}`;
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64)
		throw new Error(
			"Skill slug must be canonical lowercase text of at most 64 characters",
		);
	const apply = switches.has("--apply");
	const reviewed = switches.has("--reviewed");
	const reviewReason = values.get("--review-reason")?.trim() ?? "";
	if (
		apply &&
		(!reviewed || reviewReason.length < 10 || reviewReason.length > 500)
	)
		throw new Error(
			"Apply requires --reviewed and a review reason of 10 to 500 characters",
		);
	return {
		apiUrl: api.origin,
		organizationId,
		workerId,
		slug,
		apply,
		reviewed,
		reviewReason,
		googleProvider,
		googleCalendars,
		outlookProvider,
		outlookCalendars,
	};
}
export function sourceHash(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}
export function installPlan(options: InstallOptions, assets: Assets) {
	const manifest = parseCapabilityManifest(assets.content);
	if (
		manifest.network ||
		manifest.mcp.os?.length !== 1 ||
		manifest.mcp.os[0] !== METHOD ||
		Object.keys(manifest.mcp).length !== 1
	)
		throw new Error(
			"Asset must declare only the canonical reconciliation method and no direct network access",
		);
	if (!assets.workflow.trim()) throw new Error("Workflow source is required");
	const resources: OsBlueprintResourceRequirement[] = [];
	for (const [kind, provider, count, scopes] of [
		[
			"google",
			options.googleProvider,
			options.googleCalendars,
			[GOOGLE_EVENTS, GOOGLE_LIST],
		],
		[
			"outlook",
			options.outlookProvider,
			options.outlookCalendars,
			["Calendars.ReadWrite"],
		],
	] as const) {
		if (!provider) continue;
		for (let index = 1; index <= count; index++)
			resources.push({
				slot: `${kind}_calendar_${index}`,
				providerId: provider,
				tokenScope: "user",
				resourceType: "calendar",
				label: `${kind === "google" ? "Google" : "Outlook"} calendar ${index}`,
				scopes: [...scopes],
			});
	}
	return {
		mode: options.apply ? "apply" : "dry_run",
		organizationId: options.organizationId,
		workerId: options.workerId,
		slug: options.slug,
		blueprintName: `Calendar coordinator · ${options.slug}`,
		workflowSha256: sourceHash(assets.workflow),
		resources,
		steps: [
			"Verify worker, provider and tool catalog",
			"Create a new worker-owned draft",
			"Apply explicit operator lifecycle review",
			"Read back exact owner, revision and source",
			"Create, pin and publish an organization-local Blueprint",
		],
		next: "Instantiate the Blueprint, connect and select named calendars, grant finite consent, preview, then enable automation in the workspace",
	};
}
function verifyProviders(
	providers: Awaited<
		ReturnType<InstallerClient["connections"]["listProviders"]>
	>["data"],
	resources: OsBlueprintResourceRequirement[],
) {
	for (const resource of resources) {
		const provider = providers.find((row) => row.appId === resource.providerId);
		if (
			!provider?.enabled ||
			provider.connectionType !== "oauth" ||
			!provider.supportedScopes.includes("user")
		)
			throw new Error(
				`Personal OAuth provider is unavailable: ${resource.providerId}`,
			);
		if (
			!resource.scopes.every(
				(scope) =>
					provider.availableScopes.includes(scope) ||
					(scope.startsWith(`${GOOGLE_ROOT}.`) &&
						provider.availableScopes.includes(GOOGLE_ROOT)),
			)
		)
			throw new Error(
				`Provider catalog lacks required calendar scopes: ${resource.providerId}`,
			);
	}
}
export async function installAssets(
	options: InstallOptions,
	assets: Assets,
	client?: InstallerClient,
) {
	const plan = installPlan(options, assets);
	if (!options.apply) return plan;
	if (
		!options.reviewed ||
		options.reviewReason.length < 10 ||
		options.reviewReason.length > 500
	)
		throw new Error("Explicit operator review is required");
	if (!client)
		throw new Error("Authenticated canonical API client is required");
	const [worker, providers, existing, blueprints, app] = await Promise.all([
		client.tedis.get({ tediId: options.workerId }),
		client.connections.listProviders({}),
		client.skills.listByOrg({ query: options.slug, limit: 100, summary: true }),
		client.osWorkspaces.blueprints.list({ limit: 100 }),
		client.apps.getBySlugWithTools({ slug: "tedix", toolIds: [METHOD] }),
	]);
	if (
		worker.id !== options.workerId ||
		worker.organizationId !== options.organizationId ||
		worker.status !== "active" ||
		worker.retiredAt
	)
		throw new Error(
			"Selected worker is not active in the requested organization",
		);
	verifyProviders(providers.data, plan.resources);
	if (
		existing.total > existing.entries.length ||
		existing.entries.some((entry) => entry.slug === options.slug)
	)
		throw new Error(
			"Skill exists or catalog is incomplete; inspect it instead of overwriting",
		);
	if (
		blueprints.truncated ||
		blueprints.items.some((row) => row.name === plan.blueprintName)
	)
		throw new Error(
			"Blueprint exists or catalog is incomplete; inspect it instead of overwriting",
		);
	const tool = app.tools.find((row) => row.toolId === METHOD && row.enabled);
	if (
		!app.app ||
		app.app.slug !== "tedix" ||
		!tool ||
		tool.config?.endpoint !== "calendarCoordinator/reconcileSubscription"
	)
		throw new Error("Canonical reconciliation tool is not installed");
	const recorded = await client.skills.record({
		title: options.slug,
		description:
			"Private calendar blockers with reviewed accounts, provider notifications and safe readback",
		tediId: options.workerId,
		visibility: "org",
		content: assets.content,
		files: { "scripts/workflow.ts": assets.workflow },
		appId: app.app.id,
		toolIds: [tool.id],
		validate: "error",
	});
	const skillId = recorded.entry.id;
	if (
		recorded.entry.organizationId !== options.organizationId ||
		recorded.entry.tediId !== options.workerId ||
		recorded.entry.slug !== options.slug ||
		recorded.entry.lifecycleState !== "draft" ||
		recorded.entry.content !== assets.content ||
		recorded.entry.files?.["scripts/workflow.ts"] !== assets.workflow ||
		!recorded.entry.toolIds?.includes(tool.id)
	)
		throw new Error(
			`Created skill ${skillId} has unexpected ownership or lifecycle; stopped before activation`,
		);
	await client.skills.improve({
		id: skillId,
		title: `Calendar coordinator · ${worker.name}`,
		lifecycleState: "active",
		force: true,
		validate: "error",
		revisionReasoning: `Operator reviewed installation: ${options.reviewReason}`,
	});
	const { entry } = await client.skills.get({ id: skillId });
	if (
		!entry ||
		entry.id !== skillId ||
		entry.organizationId !== options.organizationId ||
		entry.tediId !== options.workerId ||
		entry.slug !== options.slug ||
		entry.lifecycleState !== "active" ||
		!Number.isSafeInteger(entry.revision) ||
		entry.revision < 1 ||
		entry.content !== assets.content ||
		entry.files?.["scripts/workflow.ts"] !== assets.workflow ||
		sourceHash(entry.files["scripts/workflow.ts"]) !== plan.workflowSha256 ||
		!entry.toolIds?.includes(tool.id)
	)
		throw new Error(
			`Skill ${skillId} readback differs from reviewed asset; stopped before Blueprint creation`,
		);
	const definition = OsBlueprintDefinitionSchema.parse({
		gadgets: [],
		requirements: {
			version: 1,
			skills: [
				{
					role: "flow",
					skillId,
					slug: options.slug,
					revision: entry.revision,
					workflowSha256: plan.workflowSha256,
				},
			],
			connections: [],
			resources: plan.resources,
			policies: [],
			runtime: null,
			layout: null,
			outputs: [],
		},
	});
	const { blueprint } = await client.osWorkspaces.blueprints.create({
		name: plan.blueprintName,
		description:
			"Connect selected calendars, review personal access, preview blockers and explicitly enable monitoring",
	});
	if (
		blueprint.organizationId !== options.organizationId ||
		blueprint.status !== "draft" ||
		blueprint.name !== plan.blueprintName
	)
		throw new Error(
			`Blueprint ${blueprint.id} has unexpected ownership; installation stopped`,
		);
	await client.osWorkspaces.blueprints.revise({
		blueprintId: blueprint.id,
		expectedRevision: 0,
		definition,
	});
	const published = await client.osWorkspaces.blueprints.publish({
		blueprintId: blueprint.id,
	});
	const current = await client.osWorkspaces.blueprints.get({
		blueprintId: blueprint.id,
	});
	if (
		current.blueprint.organizationId !== options.organizationId ||
		current.blueprint.status !== "published" ||
		current.currentRevision?.id !== published.revision.id ||
		!isDeepStrictEqual(current.currentRevision.definition, definition)
	)
		throw new Error(
			`Blueprint ${blueprint.id} readback differs from pinned definition; inspect installation`,
		);
	return {
		...plan,
		skillId,
		skillRevision: entry.revision,
		blueprintId: blueprint.id,
		blueprintRevisionId: published.revision.id,
		monitoring: "not_installed",
	};
}
export async function main(
	argv: string[],
	environment: Record<string, string | undefined> = process.env,
) {
	const options = parseOptions(argv);
	const [content, workflow] = await Promise.all([
		readFile(
			new URL(
				"../../apps/skill-runtime/examples/calendar-coordinator/SKILL.md",
				import.meta.url,
			),
			"utf8",
		),
		readFile(
			new URL(
				"../../apps/skill-runtime/examples/calendar-coordinator/scripts/workflow.ts",
				import.meta.url,
			),
			"utf8",
		),
	]);
	if (!options.apply) return installAssets(options, { content, workflow });
	const key = environment.TEDIX_API_KEY;
	if (!key?.startsWith("sk_"))
		throw new Error("Apply requires a scoped TEDIX_API_KEY in the environment");
	const [{ getApiClient }, { withApiKey }] = await Promise.all([
		import("@tedix/api-client/client"),
		import("@tedix/api-client/adapters"),
	]);
	const client = getApiClient<ApiContract>(options.apiUrl, {
		getHeaders: withApiKey(key),
		credentials: "omit",
		timeoutMs: 30_000,
	});
	return installAssets(options, { content, workflow }, client);
}
if (import.meta.main) {
	main(process.argv.slice(2))
		.then((result) => console.log(JSON.stringify(result, null, 2)))
		.catch(() => {
			// Transport errors can include request data. Never echo credential-bearing details.
			console.error(
				"Calendar coordinator installation stopped. Inspect created assets before retrying; check arguments, catalog, permissions and operator review.",
			);
			process.exitCode = 1;
		});
}
