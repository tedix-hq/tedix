/**
 * The access level chosen on an attached personal account (none, read,
 * organise) and "run now" for a Workspace's linked skill: owner-only grants
 * that never reach a send or delete tool, and a run that does not start
 * without the access it needs.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { apps, appTools } from "@tedix/db/schema";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillRuns, skillSchedules } from "@tedix/db/schema/cognitive";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { personalResourceDelegations } from "@tedix/db/schema/personal-resource-delegations";
import { tedis } from "@tedix/db/schema/tedis";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	skills: new Map<string, unknown>(),
	runtime: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: async (_db: unknown, id: string) => mocks.skills.get(id),
}));
vi.mock("../../services/skill-runtime-client", () => ({
	callSkillRuntime: mocks.runtime,
}));
vi.mock("../../services/personal-resource-delegation-authority", () => ({
	// Consent checks against the live vault are covered by their own tests.
	preparePersonalResourceDelegation: async (
		context: BaseContext,
		input: Record<string, unknown>,
	) => ({
		...input,
		id: crypto.randomUUID(),
		organizationId: "org-1",
		ownerUserId: context.user?.sub,
		providerId: "google-gmail",
		resourceType: "mailbox",
		providerResourceId: "robin@example.test",
		accountSubject: "google-robin",
		grantFingerprint: "fingerprint",
		requiredScopes: [],
		createdAt: new Date().toISOString(),
		revokedAt: null,
	}),
	validatePersonalRunSources: mocks.validate,
	personalDelegationSource: (row: Record<string, unknown>) => ({
		workspaceResourceId: row.resourceId,
		workspaceId: row.workspaceId,
		providerId: row.providerId,
		resourceType: row.resourceType,
		providerResourceId: row.providerResourceId,
		connectionScope: "user",
		personalOwnerUserId: row.ownerUserId,
		connectionInstanceId: row.connectionInstanceId,
		delegationId: row.id,
		requiredScopes: row.requiredScopes,
		operations: row.operations,
		toolIds: row.toolIds,
	}),
}));

const { osWorkspacesContractRouter } = await import("./os-workspaces");

const OWNER = "member-robin";
const OTHER = "member-kai";
const TEDI = "10000000-0000-4000-8000-0000000000aa";
const FACTORY = "inbox-factory-skill";
const ACTIONS = "inbox-actions-skill";
const ACCOUNT = "10000000-0000-4000-8000-0000000000c1";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			osWorkspaces,
			osWorkspaceResources,
			personalResourceDelegations,
			apps,
			appTools,
			userConfigs,
			auditEvents,
			organizationMembers,
			skillRuns,
			skillSchedules,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'Fictional Org');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','member','active'),
		       ('m-kai','org-1','member-kai','kai@example.test','member','active');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
}

function member(env: CloudflareEnv, sub: string) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: {
			authType: "user",
			db: createDbClient(env.DB) as BaseContext["db"],
			env,
			headers: new Headers(),
			organizationId: "org-1",
			url: new URL("https://api.tedix.test/rpc/os-workspaces"),
			user: {
				aud: "test",
				dct: "tenant-1",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions: ["os:read", "os:author", "os:admin"],
				roles: [],
				sub,
			},
		} as BaseContext,
	});
}

function skill(id: string, gmailTools: string[]) {
	return {
		id,
		slug: id,
		tediId: TEDI,
		revision: 3,
		lifecycleState: "active",
		content: `---\nname: ${id}\ncapabilities:\n  mcp:\n    tedix: [get_os_output]\n    google_gmail: [${gmailTools.join(", ")}]\n---\n# ${id}\n`,
		files: { "scripts/workflow.ts": "export default { async run() {} };" },
	};
}

const GMAIL_TOOLS = [
	"search_threads",
	"get_thread",
	"list_labels",
	"label_thread",
	"unlabel_thread",
	"create_label",
	"create_draft",
	"trash_thread",
	"send_message",
];

async function seed(env: CloudflareEnv) {
	const db = createDbClient(env.DB);
	await db.insert(apps).values([
		{
			id: "app-mail",
			organizationId: "org-1",
			name: "Google Gmail",
			slug: "google-gmail",
		},
	] as never);
	for (const [index, toolId] of GMAIL_TOOLS.entries())
		await db.insert(appTools).values({
			id: `t${index}`,
			appId: "app-mail",
			toolId,
			toolTypeId: "mcp",
			title: toolId,
			description: toolId,
			inputSchema: {},
			config: {
				transport: "mcp",
				mcpToolName: toolId,
				auth: {
					type: "connection",
					connectionId: "google-gmail",
					credentialScope: "user",
					scopes: [],
				},
			},
		} as never);
	mocks.skills.set(FACTORY, skill(FACTORY, ["search_threads"]));
	mocks.skills.set(ACTIONS, skill(ACTIONS, GMAIL_TOOLS));
	const owner = member(env, OWNER);
	const { workspace } = await owner.workspaces.create({
		name: "Robin's inbox",
		visibility: "private",
	});
	const now = new Date().toISOString();
	const row = (id: string, values: Record<string, unknown>) => ({
		id,
		organizationId: "org-1",
		workspaceId: workspace.id,
		slot: null,
		connectionScope: "tenant",
		personalOwnerUserId: null,
		connectionInstanceId: null,
		providerAccess: null,
		requiredScopes: "[]",
		metadata: "{}",
		status: "active",
		createdByKind: "user",
		createdById: OWNER,
		createdAt: now,
		updatedAt: now,
		removedAt: null,
		...values,
	});
	const mailbox = crypto.randomUUID();
	await db.insert(osWorkspaceResources).values([
		row(crypto.randomUUID(), {
			providerId: "tedix",
			resourceType: "skill",
			providerResourceId: FACTORY,
			name: "Inbox factory",
		}),
		row(crypto.randomUUID(), {
			providerId: "tedix",
			resourceType: "skill",
			providerResourceId: ACTIONS,
			name: "Inbox actions",
		}),
		row(mailbox, {
			providerId: "google-gmail",
			connectionScope: "user",
			personalOwnerUserId: OWNER,
			connectionInstanceId: ACCOUNT,
			resourceType: "mailbox",
			providerResourceId: "robin@example.test",
			name: "Gmail: robin@example.test",
		}),
	] as never);
	return { workspaceId: workspace.id, mailbox };
}

beforeEach(() => {
	mocks.skills.clear();
	mocks.runtime.mockReset();
	mocks.runtime.mockResolvedValue({ runId: "run-1" });
	mocks.validate.mockReset();
	mocks.validate.mockImplementation(
		async (_context: unknown, input: { resourceAccessEnvelope: unknown }) =>
			input.resourceAccessEnvelope,
	);
});

describe("access level on an attached personal account", () => {
	it("organise grants each linked skill its declared read and organise tools, never send or trash", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		const result = await member(env, OWNER).schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "organise",
		});
		const bySkill = Object.fromEntries(
			result.skills.map((entry) => [entry.skillId, entry.toolIds]),
		);
		expect(bySkill[FACTORY]).toEqual(["search_threads"]);
		expect(bySkill[ACTIONS]).toEqual([
			"create_draft",
			"create_label",
			"get_thread",
			"label_thread",
			"list_labels",
			"search_threads",
			"unlabel_thread",
		]);
		const listed = await member(env, OWNER).schedules.list({ workspaceId });
		const actions = listed.items.find((item) => item.skillId === ACTIONS);
		expect(actions?.personalRead?.level).toBe("organise");
		// The factory declares only a read, so its grant stays read-only.
		const factory = listed.items.find((item) => item.skillId === FACTORY);
		expect(factory?.personalRead?.level).toBe("read");
	});

	it("read keeps an unchanged grant, and none revokes every grant", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		const owner = member(env, OWNER);
		const first = await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "read",
		});
		const again = await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "read",
		});
		expect(again.skills).toEqual(first.skills);
		expect(
			first.skills.find((entry) => entry.skillId === ACTIONS)?.toolIds,
		).toEqual(["get_thread", "list_labels", "search_threads"]);
		const none = await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "none",
		});
		expect(none.skills.every((entry) => entry.grantId === null)).toBe(true);
		const listed = await owner.schedules.list({ workspaceId });
		expect(listed.items.map((item) => item.personalRead?.level)).toEqual([
			"none",
			"none",
		]);
	});

	it("only the account's owner can choose it", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		// Another member cannot even see the private workspace.
		await expect(
			member(env, OTHER).schedules.setPersonalAccess({
				workspaceId,
				resourceId: mailbox,
				level: "organise",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("run a linked skill now", () => {
	const press = (workspaceId: string, needs?: "read" | "organise") => ({
		workspaceId,
		skillId: ACTIONS,
		params: { cardSheetId: "sheet-1", row: 2, kind: "archive" },
		idempotencyKey: crypto.randomUUID(),
		...(needs ? { needs } : {}),
	});

	it("refuses run_skill Do it without a grant, including after revocation", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		const owner = member(env, OWNER);
		const request = press(workspaceId, "organise");
		const denied = {
			status: "needs_access",
			level: "none",
			providerName: "Gmail",
			resourceId: mailbox,
		};
		await expect(owner.schedules.runNow(request)).resolves.toEqual(denied);
		await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "organise",
		});
		await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "none",
		});
		await expect(owner.schedules.runNow(request)).resolves.toEqual(denied);
		expect(mocks.runtime).not.toHaveBeenCalled();
		expect(mocks.validate).not.toHaveBeenCalled();
	});

	it("denies another member a private Workspace's linked skill even with its exact ids", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		await member(env, OWNER).schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "organise",
		});
		await expect(
			member(env, OTHER).schedules.runNow(press(workspaceId, "organise")),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			member(env, OTHER).schedules.list({ workspaceId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.runtime).not.toHaveBeenCalled();
		expect(mocks.validate).not.toHaveBeenCalled();
		await expect(
			member(env, OWNER).schedules.runNow(press(workspaceId, "organise")),
		).resolves.toEqual({ status: "started", runId: "run-1" });
	});

	it("does not start an organising run without organise access", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		const owner = member(env, OWNER);
		await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "read",
		});
		await expect(
			owner.schedules.runNow(press(workspaceId, "organise")),
		).resolves.toEqual({
			status: "needs_access",
			level: "read",
			providerName: "Gmail",
			resourceId: mailbox,
		});
		expect(mocks.runtime).not.toHaveBeenCalled();
	});

	it("starts with the owner's grants and the card params", async () => {
		const env = createEnv();
		const { workspaceId, mailbox } = await seed(env);
		const owner = member(env, OWNER);
		await owner.schedules.setPersonalAccess({
			workspaceId,
			resourceId: mailbox,
			level: "organise",
		});
		await expect(
			owner.schedules.runNow(press(workspaceId, "organise")),
		).resolves.toEqual({ status: "started", runId: "run-1" });
		const [, path, body] = mocks.runtime.mock.calls[0]!;
		expect(path).toBe("/run");
		expect(body).toMatchObject({
			createdBy: `user:${OWNER}`,
			skillId: ACTIONS,
			tediId: TEDI,
			params: {
				cardSheetId: "sheet-1",
				row: 2,
				kind: "archive",
				workspaceId,
			},
		});
		const sources = body.resourceAccessEnvelope.sources;
		expect(sources).toHaveLength(1);
		expect(sources[0].operations).toEqual(["modify", "read"]);
		expect(sources[0].toolIds).not.toContain("send_message");
		expect(sources[0].toolIds).not.toContain("trash_thread");
	});

	it("files work without any personal access, and refuses an unlinked skill", async () => {
		const env = createEnv();
		const { workspaceId } = await seed(env);
		const owner = member(env, OWNER);
		await expect(
			owner.schedules.runNow({
				...press(workspaceId),
				params: { kind: "work" },
			}),
		).resolves.toEqual({ status: "started", runId: "run-1" });
		expect(
			mocks.runtime.mock.calls[0]![2].resourceAccessEnvelope,
		).toBeUndefined();
		await expect(
			owner.schedules.runNow({ ...press(workspaceId), skillId: "elsewhere" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
