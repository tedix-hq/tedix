import { describe, expect, test } from "bun:test";
import {
	auditProviderCapabilitySnapshot,
	checkAllowedResources,
	type AuditSnapshot,
	type ToolRow,
} from "./audit-provider-capabilities";

const ORG = "org-1";

function snapshot(partial: Partial<AuditSnapshot>): AuditSnapshot {
	return {
		providers: [
			{
				id: "github",
				descope_app_id: "github",
				descope_app_aliases: null,
			},
			{ id: "notion", descope_app_id: "notion", descope_app_aliases: null },
			{
				id: "google-gmail",
				descope_app_id: "google-gmail",
				descope_app_aliases: null,
			},
			{
				id: "google-calendar",
				descope_app_id: "google-calendar",
				descope_app_aliases: null,
			},
			{
				id: "microsoft-graph-calendar-tedix",
				descope_app_id: "microsoft-graph-ca-tedix-oauth",
				descope_app_aliases: '["ms-graph-calendar"]',
			},
		],
		instances: [],
		orgLimits: [],
		tools: [],
		workspaceResources: [],
		delegations: [],
		...partial,
	};
}

function tool(partial: Partial<ToolRow>): ToolRow {
	return {
		tool_row_id: "row-1",
		app_id: "app-1",
		tool_id: "search",
		organization_id: ORG,
		transport: "mcp",
		mcp_tool_name: "get_file_contents",
		mcp_server_url: "https://api.githubcopilot.com/mcp/",
		auth_type: "connection",
		auth_connection_id: "github",
		auth_connection_instance_id: null,
		auth_scope: null,
		auth_credential_scope: null,
		personal_resource_binding: null,
		app_connection_provider_id: null,
		app_connection_instance_id: null,
		app_connection_scope: null,
		...partial,
	};
}

describe("checkAllowedResources", () => {
	test("null is unconstrained", () => {
		expect(checkAllowedResources(null, "github")).toBeNull();
	});
	test("a valid repository list passes", () => {
		expect(
			checkAllowedResources(
				JSON.stringify([
					{ resourceType: "github_repository", resourceId: "tedix-hq/tedix" },
				]),
				"github",
			),
		).toBeNull();
	});
	test("an empty list refuses every bound tool", () => {
		expect(checkAllowedResources("[]", "github")).toMatch(/empty/);
	});
	test("an unknown resource type fails the closed schema", () => {
		expect(
			checkAllowedResources(
				JSON.stringify([
					{ resourceType: "google_drive_file", resourceId: "abc" },
				]),
				"github",
			),
		).toMatch(/schema/);
	});
	test("a cross-provider resource type is outside the profile", () => {
		expect(
			checkAllowedResources(
				JSON.stringify([
					{
						resourceType: "notion_page",
						resourceId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
					},
				]),
				"github",
			),
		).toMatch(/outside the github profile/);
	});
	test("personal-account providers allow no resource list", () => {
		expect(
			checkAllowedResources(
				JSON.stringify([
					{ resourceType: "github_repository", resourceId: "a/b" },
				]),
				"google-gmail",
			),
		).toMatch(/outside the google-gmail profile/);
	});
});

describe("auditProviderCapabilitySnapshot", () => {
	test("flags an instance whose allowed resources fail the schema", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				instances: [
					{
						id: "inst-1",
						organization_id: ORG,
						provider_id: "github",
						allowed_resources: JSON.stringify([
							{ resourceType: "gitlab_project", resourceId: "a/b" },
						]),
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]).toMatchObject({
			kind: "connection-instance",
			providerId: "github",
			id: "inst-1",
		});
		expect(
			report.providers.find((p) => p.providerId === "github"),
		).toMatchObject({ exceeding: 1 });
	});

	test("keeps an unconstrained instance clean", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				instances: [
					{
						id: "inst-1",
						organization_id: null,
						provider_id: "notion",
						allowed_resources: null,
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(0);
		expect(
			report.providers.find((p) => p.providerId === "notion")!.checked
				.instances,
		).toBe(1);
	});

	test("refuses a github tool absent from the reviewed profile under limits", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				orgLimits: [
					{
						id: ORG,
						resource_limits: JSON.stringify({
							github: [
								{
									resourceType: "github_repository",
									resourceId: "tedix-hq/tedix",
								},
							],
						}),
					},
				],
				tools: [tool({ mcp_tool_name: "create_issue" })],
			}),
		);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.detail).toMatch(/outside the reviewed/);
	});

	test("allows the same tool with no limits", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({ tools: [tool({ mcp_tool_name: "create_issue" })] }),
		);
		expect(report.findings).toHaveLength(0);
	});

	test("refuses a github tool on an unofficial endpoint under limits", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				instances: [
					{
						id: "inst-1",
						organization_id: ORG,
						provider_id: "github",
						allowed_resources: JSON.stringify([
							{
								resourceType: "github_repository",
								resourceId: "tedix-hq/tedix",
							},
						]),
					},
				],
				tools: [
					tool({
						mcp_server_url: "https://mcp.evil.example/github",
						auth_connection_instance_id: "inst-1",
					}),
				],
			}),
		);
		expect(report.findings.map((finding) => finding.kind)).toContain(
			"app-tool",
		);
	});

	test("flags a user-scope gmail tool absent from the account profile", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				tools: [
					tool({
						auth_connection_id: "google-gmail",
						auth_credential_scope: "user",
						mcp_tool_name: "send_message",
						mcp_server_url: null,
					}),
				],
			}),
		);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.detail).toMatch(/absent from the reviewed/);
	});

	test("flags an account-target binding that mismatches the reviewed profile", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				tools: [
					tool({
						auth_connection_id: "google-gmail",
						mcp_tool_name: "send_message",
						mcp_server_url: null,
						personal_resource_binding: JSON.stringify({
							operation: "read",
							resourceType: "mailbox",
							target: "account",
						}),
					}),
				],
			}),
		);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.detail).toMatch(/outside the reviewed/);
	});

	test("accepts a narrowing paths binding on an unlisted tool", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				tools: [
					tool({
						auth_connection_id: "google-gmail",
						mcp_tool_name: "send_message",
						mcp_server_url: null,
						personal_resource_binding: JSON.stringify({
							operation: "read",
							resourceType: "mailbox",
							paths: [["messageId"]],
						}),
					}),
				],
			}),
		);
		expect(report.findings).toHaveLength(0);
	});

	test("flags a workspace resource requesting a scope outside the profile", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				workspaceResources: [
					{
						id: "res-1",
						organization_id: ORG,
						provider_id: "google-calendar",
						connection_scope: "user",
						resource_type: "calendar",
						required_scopes: JSON.stringify([
							"https://www.googleapis.com/auth/calendar.events.readonly",
							"https://www.googleapis.com/auth/drive.readonly",
						]),
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.detail).toMatch(/drive\.readonly/);
	});

	test("flags a delegation with a scope outside the profile and an unknown operation", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				delegations: [
					{
						id: "del-1",
						organization_id: ORG,
						provider_id: "microsoft-graph-ca-tedix-oauth",
						resource_type: "calendar",
						required_scopes: JSON.stringify(["Mail.Read"]),
						operations: JSON.stringify(["read", "send"]),
						expires_at: "2999-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(2);
		expect(
			report.providers.find(
				(p) => p.providerId === "microsoft-graph-calendar-tedix",
			)!.exceeding,
		).toBe(2);
	});

	test("accepts reviewed google calendar scopes", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				workspaceResources: [
					{
						id: "res-1",
						organization_id: ORG,
						provider_id: "google-calendar",
						connection_scope: "user",
						resource_type: "calendar",
						required_scopes: JSON.stringify([
							"https://www.googleapis.com/auth/calendar.events",
							"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
						]),
					},
				],
				delegations: [
					{
						id: "del-1",
						organization_id: ORG,
						provider_id: "google-calendar",
						resource_type: "calendar",
						required_scopes: JSON.stringify([
							"https://www.googleapis.com/auth/calendar.events",
						]),
						operations: JSON.stringify(["read", "create", "update", "delete"]),
						expires_at: "2999-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(0);
	});

	test("skips expired delegations and unclassified providers", () => {
		const report = auditProviderCapabilitySnapshot(
			snapshot({
				delegations: [
					{
						id: "del-old",
						organization_id: ORG,
						provider_id: "google-gmail",
						resource_type: "mailbox",
						required_scopes: JSON.stringify(["https://example.com/bad"]),
						operations: JSON.stringify(["read"]),
						expires_at: "2000-01-01T00:00:00.000Z",
					},
					{
						id: "del-x",
						organization_id: ORG,
						provider_id: "some-other-provider",
						resource_type: "x",
						required_scopes: "[]",
						operations: "[]",
						expires_at: "2999-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		expect(report.findings).toHaveLength(0);
		expect(report.unclassifiedProviderRows).toBe(1);
	});
});
