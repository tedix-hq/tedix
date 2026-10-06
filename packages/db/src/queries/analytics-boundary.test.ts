import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import { widgetEvents } from "../schema/analytics";
import { auditEvents } from "../schema/audit-events";
import { appCatalog } from "../schema/catalog";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";
import { appTools } from "../schema/tools";
import { items } from "../schema/items";
import { users } from "../schema/users";
import { providerInstallations } from "../schema/provider-installations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getAnalyticsAppFreshness,
	listAnalyticsAuditActivityWindow,
	listAnalyticsExecutionAuditRows,
	listAnalyticsRationaleEvidence,
	listAnalyticsRuntimeTraceEvidence,
	listAnalyticsTraceActivity,
	listRecentAnalyticsAuditActivity,
} from "./analytics-audit";
import {
	listAnalyticsAppsByIds,
	listAnalyticsAppsBySlugs,
	listAnalyticsOrganizationMembers,
	listAnalyticsTedis,
	listAnalyticsTools,
	listAnalyticsUsers,
} from "./analytics-hydration";
import {
	listEmbeddedAttentionReviews,
	listEmbeddedProviderActivity,
} from "./analytics";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			appCatalog,
			apps,
			items,
			widgetEvents,
			appTools,
			organizationMembers,
			users,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			auditEvents,
			tediRuntimeEvents,
			tediRationaleRecords,
			providerInstallations,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-1', 'One', 'one'),
			('org-2', 'Two', 'two');
		INSERT INTO apps (id, organization_id, name, slug) VALUES
			('app-1', 'org-1', 'App One', 'app-one'),
			('app-2', 'org-2', 'App Two', 'app-two');
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("analytics query boundary", () => {
	it("lists embedded activity only through provider-owned installations", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(`
			INSERT INTO provider_installations (
				id, provider_organization_id, provider_app_id, provider_api_key_id,
				external_tenant_id, customer_organization_id, primary_workspace_id,
				primary_tedi_id, allowed_origin, host_tenant_argument,
				host_tenant_namespace, provisioned_by
				, created_at, updated_at
			) VALUES
				('installation-1', 'org-1', 'app-1', 'key-1', '1', 'org-1',
				 'workspace-1', 'tedi-1', 'https://www.acme.example', 'companyId',
				 'acme_staging', 'test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
				('installation-2', 'org-2', 'app-2', 'key-2', '8042', 'org-2',
				 'workspace-2', 'tedi-2', 'https://other.example.com', 'companyId',
				 'acme_other', 'test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
			INSERT INTO widget_events (
				id, organization_id, app_id, session_id, event_type, metadata, created_at
			) VALUES
				('session-current', 'org-1', 'app-1', 'embed:one', 'embedded_session_started',
				 '{"installationId":"installation-1","hostUserId":"6190","hostUserLabel":"Ada","hostRole":"owner"}',
				 '2026-09-01T12:00:00.000Z'),
				('session-other', 'org-2', 'app-2', 'embed:two', 'embedded_session_started',
				 '{"installationId":"installation-2","hostUserId":"6190"}',
				 '2026-09-01T12:01:00.000Z');
		`);
		await expect(
			listEmbeddedProviderActivity(db, {
				providerOrganizationId: "org-1",
				from: "2026-09-01T00:00:00.000Z",
				to: "2026-09-02T00:00:00.000Z",
				limit: 50,
			}),
		).resolves.toMatchObject([
			{
				id: "session-current",
				installationId: "installation-1",
				externalTenantId: "1",
				hostUserId: "6190",
			},
		]);
		sqlite.exec(
			`INSERT INTO widget_events (id, organization_id, app_id, session_id, event_type, metadata, created_at) VALUES ('busy-user', 'org-1', 'app-1', 'newer-session', 'embedded_session_started', '{"installationId":"installation-1","hostUserId":"another-user"}', '2026-09-01T13:00:00.000Z')`,
		);
		const scope = {
			providerOrganizationId: "org-1",
			from: "2026-09-01T00:00:00.000Z",
			to: "2026-09-02T00:00:00.000Z",
			limit: 1,
			hostUserId: "6190",
		};
		expect(
			await listEmbeddedProviderActivity(db, {
				...scope,
				installationId: "installation-1",
			}),
		).toMatchObject([{ id: "session-current" }]);
		expect(
			await listEmbeddedProviderActivity(db, {
				...scope,
				installationId: "installation-2",
			}),
		).toEqual([]);
	});

	it("correlates opaque reviews only inside the signed installation and actor boundary", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO widget_events (
				id, organization_id, app_id, session_id, event_type,
				widget_key, metadata, created_at
			) VALUES
				('review-current', 'org-1', 'app-1', 'session-1', 'attention_review',
				 'attn_0123456789abcdef0123456789abcdef',
				 '{"installationId":"installation-1","tediId":"tedi-1","hostOrganizationId":"1","hostUserId":"6190","origin":"https://www.acme.example"}',
				 '2026-08-31T04:00:00.000Z'),
				('review-other-actor', 'org-1', 'app-1', 'session-2', 'attention_review',
				 'attn_fedcba9876543210fedcba9876543210',
				 '{"installationId":"installation-1","tediId":"tedi-1","hostOrganizationId":"1","hostUserId":"other","origin":"https://www.acme.example"}',
				 '2026-08-31T04:01:00.000Z'),
				('review-other-org', 'org-2', 'app-2', 'session-3', 'attention_review',
				 'attn_0123456789abcdef0123456789abcdef',
				 '{"installationId":"installation-2","tediId":"tedi-2","hostOrganizationId":"8042","hostUserId":"6190","origin":"https://www.acme.example"}',
				 '2026-08-31T04:02:00.000Z');
		`);

		await expect(
			listEmbeddedAttentionReviews(db, {
				organizationId: "org-1",
				appId: "app-1",
				installationId: "installation-1",
				tediId: "tedi-1",
				hostOrganizationId: "1",
				hostUserId: "6190",
				origin: "https://www.acme.example",
				attentionRefs: [
					"attn_0123456789abcdef0123456789abcdef",
					"attn_fedcba9876543210fedcba9876543210",
				],
			}),
		).resolves.toEqual([
			{
				attentionRef: "attn_0123456789abcdef0123456789abcdef",
				reviewedAt: "2026-08-31T04:00:00.000Z",
			},
		]);
	});

	it("keeps audit freshness, activity, trace, and drilldown reads tenant-scoped", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO audit_events (
				id, organization_id, actor_id, actor_type, action,
				resource_type, resource_id, metadata, timestamp
			) VALUES
				('event-1', 'org-1', 'user-1', 'user', 'mcp.code.execute',
				 'mcp', 'code',
				 '{"appId":"app-1","executionId":"exec-1","traceId":"trace-1","durationMs":8,"toolCount":4,"namespaceCount":2}',
				 100),
				('event-2', 'org-2', 'user-2', 'user', 'mcp.tool.error',
				 'mcp', 'private_tool',
				 '{"appId":"app-2","executionId":"exec-1","traceId":"trace-1","errorCode":"PRIVATE"}',
				 110);
		`);

		await expect(
			getAnalyticsAppFreshness(db, {
				organizationId: "org-1",
				appId: "app-1",
				windowStartSeconds: 90,
				windowEndSeconds: 120,
			}),
		).resolves.toMatchObject({
			countsRow: { totalEvents: 1, codeExecutions: 1 },
			latestRow: { action: "mcp.code.execute", traceId: "trace-1" },
		});
		await expect(
			listRecentAnalyticsAuditActivity(db, {
				organizationId: "org-1",
				appId: "app-1",
				actorId: "user-1",
				limit: 10,
			}),
		).resolves.toMatchObject([{ resourceId: "code", traceId: "trace-1" }]);
		await expect(
			listAnalyticsTraceActivity(db, {
				organizationId: "org-1",
				traceId: "trace-1",
			}),
		).resolves.toHaveLength(1);
		await expect(
			listAnalyticsExecutionAuditRows(db, {
				organizationId: "org-1",
				executionId: "exec-1",
			}),
		).resolves.toMatchObject([{ action: "mcp.code.execute" }]);
		await expect(
			listAnalyticsAuditActivityWindow(db, {
				organizationId: "org-2",
				startSeconds: 90,
				endSeconds: 120,
				limit: 10,
			}),
		).resolves.toMatchObject([{ errorCode: "PRIVATE" }]);
	});

	it("hydrates app, tool, member, user, and tedi identities through D1", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			UPDATE apps SET source_app_id = 'app-1' WHERE id = 'app-2';
			INSERT INTO app_tools (id, app_id, tool_id, title, input_schema, tool_type_id)
			VALUES ('tool-row-1', 'app-1', 'list_items', 'List Items', '{}', 'rpc');
			INSERT INTO organization_members (
				id, organization_id, descope_user_id, email, name, role
			) VALUES
				('member-1', 'org-1', 'user-1', 'one@example.com', 'One User', 'admin'),
				('member-2', 'org-2', 'user-1', 'two@example.com', 'Two User', 'member');
			INSERT INTO users (id, email, name)
			VALUES ('user-1', 'global@example.com', 'Global User');
			INSERT INTO tedis (
				id, organization_id, name, slug, display_name, descope_user_id
			) VALUES
				('tedi-1', 'org-1', 'CTO', 'cto', 'Chief Technology Officer', 'tedi-user-1'),
				('tedi-2', 'org-2', 'Other', 'other', 'Other Tedi', 'tedi-user-2');
		`);

		await expect(listAnalyticsAppsByIds(db, ["app-1"])).resolves.toEqual([
			{ id: "app-1", name: "App One", slug: "app-one" },
		]);
		await expect(listAnalyticsAppsBySlugs(db, ["app-two"])).resolves.toEqual([
			{
				id: "app-2",
				name: "App Two",
				slug: "app-two",
				sourceAppId: "app-1",
			},
		]);
		await expect(
			listAnalyticsTools(db, {
				appIds: ["app-1"],
				toolIds: ["list_items"],
			}),
		).resolves.toEqual([
			{ appId: "app-1", toolId: "list_items", title: "List Items" },
		]);
		await expect(
			listAnalyticsOrganizationMembers(db, {
				organizationId: "org-1",
				userIds: ["user-1"],
			}),
		).resolves.toMatchObject([{ email: "one@example.com" }]);
		await expect(listAnalyticsUsers(db, ["user-1"])).resolves.toMatchObject([
			{ name: "Global User" },
		]);
		await expect(
			listAnalyticsTedis(db, {
				organizationId: "org-1",
				principalIds: ["tedi-user-1", "tedi-user-2"],
				tediIds: ["tedi-1", "tedi-2"],
				slugs: ["cto", "other"],
			}),
		).resolves.toMatchObject([{ id: "tedi-1", slug: "cto" }]);
	});

	it("chunks oversized trace and rationale lookups below D1 parameter limits", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO tedis (id, organization_id, name, slug)
			VALUES ('tedi-1', 'org-1', 'CTO', 'cto');
			INSERT INTO tedi_runtime_events (
				id, organization_id, tedi_id, kind, payload,
				runtime_backend, runtime_metadata, trace_id, created_at
			) VALUES
				('runtime-2', 'org-1', 'tedi-1', 'run.completed', '{}',
				 'cloudflare-agents', '{"traceId":"stale-metadata-2"}', 'trace-2', '2026-08-01T00:02:00Z'),
				('runtime-1', 'org-1', 'tedi-1', 'run.started', '{}',
				 'cloudflare-agents', '{"traceId":"stale-metadata-1"}', 'trace-1', '2026-08-01T00:01:00Z');
			INSERT INTO tedi_rationale_records (
				id, tedi_id, org_id, action, rationale, evidence, created_at
			) VALUES
				('decision-1', 'tedi-1', 'org-1', 'decide', 'One', '{}', '2026-08-01T00:01:00Z'),
				('decision-2', 'tedi-1', 'org-1', 'decide', 'Two', '{}', '2026-08-01T00:02:00Z');
		`);
		const traceIds = Array.from(
			{ length: 101 },
			(_, index) => `trace-${index}`,
		);
		const decisionIds = Array.from(
			{ length: 101 },
			(_, index) => `decision-${index}`,
		);

		await expect(
			listAnalyticsRuntimeTraceEvidence(db, {
				organizationId: "org-1",
				traceIds,
			}),
		).resolves.toMatchObject([
			{ traceId: "trace-1", kind: "run.started" },
			{ traceId: "trace-2", kind: "run.completed" },
		]);
		const traceIndexColumns = sqlite
			.prepare("PRAGMA index_info('idx_tedi_runtime_events_trace')")
			.all()
			.map((row) => row.name);
		expect(traceIndexColumns).toEqual(["trace_id", "created_at"]);
		await expect(
			listAnalyticsRationaleEvidence(db, {
				organizationId: "org-1",
				decisionIds,
			}),
		).resolves.toMatchObject([{ id: "decision-1" }, { id: "decision-2" }]);
	});
});
