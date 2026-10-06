import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { toolToGranularCapabilityScope } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import { describe, expect, it } from "vite-plus/test";
import { PLATFORM_OPERATOR_TOOL_DEFINITIONS } from "./platform-operator-tools";

type OperatorDefinition =
	(typeof PLATFORM_OPERATOR_TOOL_DEFINITIONS)[number] & {
		description?: string;
		widget?: {
			layoutId: string;
			description: string;
			layoutSpec: Record<string, unknown>;
		};
	};

function definition(toolId: string) {
	const found = PLATFORM_OPERATOR_TOOL_DEFINITIONS.find(
		(candidate) => candidate.toolId === toolId,
	);
	expect(found).toBeTruthy();
	return found! as OperatorDefinition;
}

function expectOperatorWidget(toolId: string, layoutId: string) {
	const tool = definition(toolId);

	expect(tool.widget).toMatchObject({
		layoutId,
		description: expect.any(String),
	});
	expect(tool.widget?.layoutSpec).toMatchObject({
		root: expect.any(String),
		elements: expect.any(Object),
	});
}

describe("platform operator tool definitions", () => {
	it("curates the Tedix admin oRPC surface that is persisted in D1", () => {
		const toolIds = PLATFORM_OPERATOR_TOOL_DEFINITIONS.map(
			(tool) => tool.toolId,
		);
		const ids = new Set(toolIds);

		expect(ids.size).toBe(toolIds.length);
		expect(ids).toContain("list_os_workspaces");
		expect(ids).toContain("create_os_workspace");
		expect(ids).toContain("get_os_workspace");
		expect(ids).toContain("update_os_workspace");
		expect(ids).toContain("revise_os_gadget");
		expect(ids).toContain("run_os_gadget");
		expect(ids).toContain("export_os_output");
		expect(ids).toContain("list_os_gadgets");
		expect(ids).toContain("create_os_gadget");
		expect(ids).toContain("patch_os_document");
		expect(ids).toContain("set_os_sheet_range");
		expect(ids).toContain("list_os_blueprints");
		expect(ids).toContain("get_os_blueprint");
		expect(ids).toContain("instantiate_os_blueprint");
		expect(ids).toContain("create_os_blueprint");
		expect(ids).toContain("list_os_outputs");
		expect(ids).toContain("get_catalog_stats");
		expect(ids).toContain("run_openapi_import");
		expect(ids).toContain("install_tenant_mcp_app");
		expect(ids).toContain("create_tenant_openapi_mcp_app");
		expect(ids).toContain("create_mcp_connection_provider");
		expect(ids).toContain("initiate_connection");
		expect(ids).toContain("store_connection_api_key");
		expect(ids).toContain("create_generated_widget_artifact");
		expect(ids).toContain("run_widget_browser_qa");
		expect(ids).toContain("query_gsc_search_analytics");
		expect(ids).toContain("research_keywords");
		expect(ids).toContain("get_serp_results");
		expect(ids).toContain("get_domain_overview");
		expect(ids).toContain("get_backlinks_overview");
		expect(ids).toContain("get_search_discovery_status");
		expect(ids).toContain("configure_search_discovery");
		expect(ids).toContain("register_google_property");
		expect(ids).toContain("verify_google_property");
		expect(ids).toContain("submit_google_sitemap");
		expect(ids).toContain("create_tedi");
		expect(ids).toContain("decommission_tedi");
		expect(ids).toContain("assign_tedi_to_app");
		expect(ids).toContain("validate_tedi_mcp_access");
		expect(ids).toContain("validate_tedi_mcp_access_batch");
		expect(ids).toContain("repair_tedi_mcp_access_batch");
		expect(ids).toContain("get_tedi_mcp_access_health");
		expect(ids).toContain("run_tedi_mcp_access_health_workflow");
		expect(ids).toContain("list_tedi_email_address_requests");
		expect(ids).toContain("provision_tedi_email_address");
		expect(ids).toContain("list_workflow_definitions");
		expect(ids).toContain("list_workflow_definition_health");
		expect(ids).toContain("get_workflow_status");
		expect(ids).toContain("list_workflow_runs");
		expect(ids).toContain("create_tenant_openapi_mcp_app");
		expect(ids).toContain("check_tool_schema_sync");
		expect(ids).toContain("run_mcp_protocol_probe");
		expect(ids).toContain("repair_cms_media");
		expect(ids).toContain("create_cms_site");
		expect(ids).toContain("begin_cms_domain");
		expect(ids).toContain("get_cms_domain");
		expect(ids).toContain("verify_cms_domain");
		expect(ids).toContain("remove_cms_domain");
		expect(ids).toContain("create_external_agent_principal");
		expect(ids).toContain("record_external_agent_knowledge_checkpoint");
		expect(ids).toContain("record_external_agent_knowledge_disposition");
		expect(ids).toContain("end_external_agent_session");
		expect(ids).toContain("retire_abandoned_external_agent_session");
		expect(ids).toContain("revoke_external_agent_mcp_credential");
		expect(ids).toContain("list_stale_external_agent_knowledge_sessions");
		expect(ids).not.toContain("resolve_external_agent_session_auth");
		expect(ids).not.toContain("record_verified_mcp_execution");
	});

	it("resolves every curated operator endpoint against the oRPC contract", () => {
		for (const tool of PLATFORM_OPERATOR_TOOL_DEFINITIONS) {
			const resolved = resolveContractEndpoint(tool.endpoint);

			expect(resolved, tool.endpoint).toBeTruthy();
			expect(resolved?.outputSchema, tool.endpoint).toBeTruthy();
		}
	});

	it("marks read, write, and destructive operator intents", () => {
		expect(definition("get_catalog_stats").kind).toBe("read");
		expect(definition("run_openapi_import").kind).toBe("write");
		expect(definition("create_tedi").kind).toBe("write");
		expect(definition("create_generated_widget_artifact").kind).toBe("write");
		expect(definition("delete_app").kind).toBe("destructive");
		expect(definition("decommission_tedi").kind).toBe("destructive");
		expect(definition("create_os_gadget").kind).toBe("write");
		expect(definition("update_os_workspace").kind).toBe("write");
		expect(definition("run_os_gadget").kind).toBe("destructive");
		expect(definition("repair_cms_media").kind).toBe("write");
		expect(definition("create_cms_site").kind).toBe("write");
		expect(toolToGranularCapabilityScope("create_cms_site")).toBe(
			"mcp:content.admin",
		);
		expect(definition("begin_cms_domain").kind).toBe("write");
		expect(definition("get_cms_domain").kind).toBe("read");
		expect(definition("verify_cms_domain").kind).toBe("write");
		expect(definition("remove_cms_domain").kind).toBe("destructive");
		for (const toolId of [
			"begin_cms_domain",
			"verify_cms_domain",
			"remove_cms_domain",
		]) {
			expect(toolToGranularCapabilityScope(toolId)).toBe("mcp:content.admin");
		}
		expect(toolToGranularCapabilityScope("get_cms_domain")).toBe(
			"mcp:content.read",
		);
		expect(definition("delete_os_gadget").kind).toBe("destructive");
	});

	it("keeps generated widget operator tools searchable", () => {
		const createArtifact = definition("create_generated_widget_artifact");
		const runQa = definition("run_widget_browser_qa");

		expect(createArtifact.description).toContain("generated widget artifact");
		expect(createArtifact.description).toContain("MCP UI");
		expect(runQa.description).toContain("Browser QA");
		expect(runQa.description).toContain("widget");
	});

	it("defines persisted render widget overlays for operator workflow surfaces", () => {
		expectOperatorWidget("get_catalog_stats", "catalog-stats");
		expectOperatorWidget("get_catalog_sync_logs", "catalog-sync-logs");
		expectOperatorWidget("get_tool_tests", "catalog-tool-tests");
		expectOperatorWidget("get_tool_test_stats", "catalog-tool-test-stats");
		expectOperatorWidget("preview_openapi_import", "openapi-import-preview");
		expectOperatorWidget(
			"list_generated_widget_artifacts",
			"generated-widget-artifacts",
		);
		expectOperatorWidget(
			"get_generated_widget_artifact",
			"generated-widget-artifact",
		);
		expectOperatorWidget(
			"list_widget_browser_qa_runs",
			"widget-browser-qa-runs",
		);
		expectOperatorWidget("get_widget_browser_qa_run", "widget-browser-qa-run");
		expectOperatorWidget("run_mcp_protocol_probe", "mcp-protocol-probe");
		expectOperatorWidget(
			"list_tedi_email_address_requests",
			"tedi-email-address-requests",
		);
		expectOperatorWidget("list_workflow_definitions", "workflow-definitions");
		expectOperatorWidget("list_workflow_definition_health", "workflow-health");
	});
});
