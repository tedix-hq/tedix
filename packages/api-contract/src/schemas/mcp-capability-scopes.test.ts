import { describe, expect, it } from "vite-plus/test";
import { DOCS_TOOL_SCOPES } from "../contracts/docs-tool-scopes";

import {
	generateGranularToolScopes,
	generateToolScopes,
	isAdminAccessLevelOverrideTool,
	toolToAccessLevel,
	toolToCapabilityScope,
	toolToGranularCapabilityScope,
} from "./mcp-capability-scopes";

describe("MCP capability scope mapping", () => {
	it("maps the exact plural approval inbox without widening Work names", () => {
		for (const prefix of ["", "work__", "tedix_unified__"]) {
			const name = `${prefix}list_work_approvals`;
			expect(toolToCapabilityScope(name)).toBe("mcp:work");
			expect(toolToGranularCapabilityScope(name)).toBe("mcp:work.read");
			expect(toolToGranularCapabilityScope(name, { readOnlyHint: false })).toBe(
				"mcp:work.write",
			);
			expect(
				toolToGranularCapabilityScope(name, { destructiveHint: true }),
			).toBe("mcp:work.admin");
			for (const unknown of [
				"list_work_approvals_unreviewed",
				"get_work_approvals",
			]) {
				expect(() => toolToCapabilityScope(`${prefix}${unknown}`)).toThrow(
					/Missing MCP capability mapping/,
				);
			}
			expect(
				toolToGranularCapabilityScope(`${prefix}propose_work_approval`),
			).toBe("mcp:work.write");
			expect(
				toolToGranularCapabilityScope(`${prefix}decide_work_approval`),
			).toBe("mcp:work.admin");
		}
	});

	it("maps the canonical tedi getter without weakening metadata tiers", () => {
		for (const prefix of [
			"",
			"tedis__",
			"tedix_unified__",
			"customer_unified__",
		]) {
			const name = `${prefix}get_tedi`;
			expect(toolToCapabilityScope(name)).toBe("mcp:tedis");
			expect(toolToGranularCapabilityScope(name)).toBe("mcp:tedis.read");
			expect(toolToGranularCapabilityScope(name, { readOnlyHint: true })).toBe(
				"mcp:tedis.read",
			);
			expect(toolToGranularCapabilityScope(name, { readOnlyHint: false })).toBe(
				"mcp:tedis.write",
			);
			expect(
				toolToGranularCapabilityScope(name, {
					readOnlyHint: true,
					destructiveHint: true,
				}),
			).toBe("mcp:tedis.admin");
			for (const unknown of ["get_tedi_unreviewed", "get_tedis", "getById"]) {
				expect(() => toolToCapabilityScope(`${prefix}${unknown}`)).toThrow(
					/Missing MCP capability mapping/,
				);
			}
		}
	});

	it("pins admission reads and administration despite access hints", () => {
		for (const prefix of ["", "work__", "tedix_unified__"]) {
			for (const hints of [
				undefined,
				{ readOnlyHint: true },
				{ readOnlyHint: false, destructiveHint: false },
			]) {
				expect(
					toolToGranularCapabilityScope(
						`${prefix}get_work_admission_specification`,
						hints,
					),
				).toBe("mcp:work.read");
				expect(
					toolToGranularCapabilityScope(
						`${prefix}replace_work_admission_specification`,
						hints,
					),
				).toBe("mcp:work.admin");
			}
			expect(
				isAdminAccessLevelOverrideTool(
					`${prefix}replace_work_admission_specification`,
				),
			).toBe(true);
		}
		for (const name of [
			"get_work_admission_specification_unreviewed",
			"replace_work_admission_specification_unreviewed",
		]) {
			expect(() => toolToCapabilityScope(name)).toThrow(
				/Missing MCP capability mapping/,
			);
		}
	});

	it("classifies authorization inventory without widening adjacent tools", () => {
		for (const toolId of [
			"list_mcp_authorizations",
			"tedix_unified__list_mcp_authorizations",
		]) {
			expect(toolToGranularCapabilityScope(toolId)).toBe("mcp:apps.read");
			expect(generateToolScopes([toolId])).toEqual({ [toolId]: ["mcp:apps"] });
			expect(generateGranularToolScopes([{ toolId }])).toEqual({
				[toolId]: ["mcp:apps.read"],
			});
			expect(
				toolToGranularCapabilityScope(toolId, { destructiveHint: true }),
			).toBe("mcp:apps.admin");
		}
		expect(() =>
			toolToCapabilityScope("list_mcp_authorizations_unreviewed"),
		).toThrow(/Missing MCP capability mapping/);
	});

	it("keeps payment review separate from changing a budget", () => {
		expect(toolToGranularCapabilityScope("request_budget_override")).toBe(
			"mcp:messaging.write",
		);
		expect(toolToGranularCapabilityScope("list_mcp_payments_events")).toBe(
			"mcp:observe.read",
		);
		expect(toolToGranularCapabilityScope("set_budget_policy")).toBe(
			"mcp:settings.admin",
		);
	});

	it("uses an explicit write hint before read-like tool names", () => {
		expect(toolToAccessLevel("gaps_resolve", { readOnlyHint: false })).toBe(
			"write",
		);
		expect(toolToAccessLevel("gaps_resolve", { readOnlyHint: true })).toBe(
			"read",
		);
		expect(toolToAccessLevel("gaps_resolve", { destructiveHint: true })).toBe(
			"admin",
		);
	});

	it("allows the site deprovision receipt to be read with content scope", () => {
		expect(toolToCapabilityScope("get_site_deprovision_status")).toBe(
			"mcp:content",
		);
		expect(
			toolToGranularCapabilityScope("get_site_deprovision_status", {
				readOnlyHint: true,
			}),
		).toBe("mcp:content.read");
	});

	it("requires content administration for CMS media repair", () => {
		expect(toolToCapabilityScope("repair_cms_media")).toBe("mcp:content");
		expect(toolToGranularCapabilityScope("repair_cms_media")).toBe(
			"mcp:content.admin",
		);
	});

	it("scopes CMS recovery capture and cleanup to content administration", () => {
		expect(toolToGranularCapabilityScope("start_cms_recovery_capture")).toBe(
			"mcp:content.admin",
		);
		expect(
			toolToGranularCapabilityScope("get_cms_recovery_capture", {
				readOnlyHint: true,
			}),
		).toBe("mcp:content.read");
		expect(
			toolToGranularCapabilityScope("purge_cms_recovery_capture", {
				destructiveHint: true,
			}),
		).toBe("mcp:content.admin");
		expect(
			toolToGranularCapabilityScope("start_cms_site_restore", {
				destructiveHint: true,
			}),
		).toBe("mcp:content.admin");
		expect(
			toolToGranularCapabilityScope("get_cms_site_restore", {
				readOnlyHint: true,
			}),
		).toBe("mcp:content.read");
	});

	it("treats own-org OS revisions as author writes without changing unknown revisions", () => {
		for (const name of [
			"revise_os_output",
			"revise_os_gadget",
			"revise_os_blueprint",
		]) {
			expect(toolToAccessLevel(name)).toBe("write");
			expect(toolToAccessLevel(`os__${name}`)).toBe("write");
		}
		expect(toolToAccessLevel("revise_unknown_resource")).toBe("admin");
	});

	it("allows CMS editorial writes without granting content administration", () => {
		for (const prefix of ["", "cms-tedix__", "cms_globex__"]) {
			for (const name of [
				"content_create",
				"content_update",
				"content_publish",
			]) {
				expect(
					toolToGranularCapabilityScope(`${prefix}${name}`, {
						readOnlyHint: false,
						destructiveHint: true,
					}),
				).toBe("mcp:content.write");
			}
			expect(
				toolToGranularCapabilityScope(`${prefix}content_delete`, {
					readOnlyHint: true,
				}),
			).toBe("mcp:content.admin");
			expect(
				toolToGranularCapabilityScope(`${prefix}content_unknown`, {
					destructiveHint: true,
				}),
			).toBe("mcp:content.admin");
		}
	});

	it("uses the Docs contract for reads, builds and publication", () => {
		for (const [name, scope] of Object.entries(DOCS_TOOL_SCOPES)) {
			expect(toolToGranularCapabilityScope(`docs_tedix__${name}`)).toBe(scope);
		}
		expect(
			toolToGranularCapabilityScope("publish_docs_build", {
				readOnlyHint: true,
			}),
		).toBe("mcp:content.admin");
		expect(() => toolToCapabilityScope("docs_tedix__get_docs_unknown")).toThrow(
			/Missing MCP capability mapping/,
		);
	});

	it("classifies MCP app scope previews as app management", () => {
		expect(toolToCapabilityScope("preview_tool_scopes")).toBe("mcp:apps");
	});

	it("treats workflow status reads as observability", () => {
		expect(toolToCapabilityScope("get_workflow_status")).toBe("mcp:observe");
		expect(toolToCapabilityScope("get_curation_console")).toBe("mcp:observe");
		expect(toolToCapabilityScope("list_workflow_definitions")).toBe(
			"mcp:observe",
		);
		expect(toolToCapabilityScope("list_workflow_definition_health")).toBe(
			"mcp:observe",
		);
		expect(toolToCapabilityScope("list_workflow_runs")).toBe("mcp:observe");
		expect(generateToolScopes(["get_workflow_status"])).toEqual({
			get_workflow_status: ["mcp:observe"],
		});
	});

	it("maps skill lifecycle and workflow tools to the skills capability", () => {
		expect(toolToCapabilityScope("skill_validate")).toBe("mcp:skills");
		expect(toolToCapabilityScope("validate_skill")).toBe("mcp:skills");
		expect(toolToCapabilityScope("run_skill_workflow")).toBe("mcp:skills");
		expect(toolToCapabilityScope("operator__run_skill_workflow")).toBe(
			"mcp:skills",
		);
		expect(toolToCapabilityScope("operator__list_promotion_candidates")).toBe(
			"mcp:skills",
		);
		for (const toolName of [
			"inspect_skill_workflow_run",
			"list_skill_workflow_steps",
			"list_skill_workflow_tool_calls",
			"list_skill_workflow_revisions",
			"get_skill_workflow_revision",
			"compare_skill_workflow_revisions",
			"get_skill_workflow_reliability",
			"pause_skill_workflow",
			"resume_skill_workflow",
			"restart_skill_workflow",
			"approve_skill_workflow",
			"reject_skill_workflow",
		]) {
			expect(toolToCapabilityScope(toolName)).toBe("mcp:skills");
		}
		expect(generateToolScopes(["run_skill_workflow"])).toEqual({
			run_skill_workflow: ["mcp:skills"],
		});
	});

	it("keeps skill access levels granular under the skills capability", () => {
		expect(toolToAccessLevel("validate_skill")).toBe("read");
		expect(toolToAccessLevel("run_skill_workflow")).toBe("write");
		expect(toolToGranularCapabilityScope("run_skill_workflow")).toBe(
			"mcp:skills.write",
		);
		expect(toolToAccessLevel("inspect_skill_workflow_run")).toBe("read");
		expect(toolToAccessLevel("restart_skill_workflow")).toBe("write");
		expect(toolToAccessLevel("reject_skill_workflow")).toBe("write");
	});

	it("maps canonical muscle-memory lifecycle tools to skills access", () => {
		expect(toolToCapabilityScope("list_muscle_memories")).toBe("mcp:skills");
		expect(toolToAccessLevel("list_muscle_memories")).toBe("read");
		for (const toolName of [
			"register_muscle_memory",
			"crystallize_muscle_memory",
			"track_muscle_usage",
		]) {
			expect(toolToCapabilityScope(toolName)).toBe("mcp:skills");
			expect(toolToAccessLevel(toolName)).toBe("write");
			expect(toolToGranularCapabilityScope(toolName)).toBe("mcp:skills.write");
		}
	});

	it("classifies Work execution separately from Work governance", () => {
		// WORK_HIERARCHY_TOOL_ID_OVERRIDES syncs these `*_work_item_*` ids; their
		// verbs match neither verb regex, so without an explicit override each
		// fell to the admin tier and the MCP edge demanded mcp:messaging.admin
		// from every non-platform-admin OAuth token.
		for (const toolName of [
			"start_work_item_attempt",
			"heartbeat_work_item_attempt",
			"settle_work_item_attempt",
			"submit_work_item_evidence",
			"complete_work_item",
			"review_work_item_evidence",
		]) {
			expect(toolToAccessLevel(toolName)).toBe("write");
		}
		for (const toolName of ["accept_work_item", "cancel_work_item"]) {
			expect(toolToAccessLevel(toolName)).toBe("admin");
		}
	});

	it("classifies credential-bound tedi workspace tools", () => {
		for (const toolName of [
			"repo_load",
			"clone_repo",
			"run_git",
			"repo_commit",
			"repo_commit_drain",
			"repo_commit_status",
			"artifact_list_files",
			"artifact_read_file",
			"artifact_write_file",
		]) {
			expect(toolToCapabilityScope(toolName)).toBe("mcp:tedis");
			expect(toolToCapabilityScope(`cto__${toolName}`)).toBe("mcp:tedis");
		}
		expect(toolToGranularCapabilityScope("repo_load")).toBe("mcp:tedis.read");
		expect(toolToGranularCapabilityScope("read")).toBe("mcp:tedis.read");
		expect(toolToGranularCapabilityScope("write")).toBe("mcp:tedis.write");
	});

	it("classifies credential-bound tedi workstation tools", () => {
		for (const toolName of [
			"open_computer",
			"close_computer",
			"exec",
			"read_execution",
			"cancel_execution",
			"write",
			"edit",
			"delete",
		]) {
			expect(toolToCapabilityScope(toolName)).toBe("mcp:tedis");
			expect(toolToCapabilityScope(`cto__${toolName}`)).toBe("mcp:tedis");
		}
		expect(toolToGranularCapabilityScope("read_execution")).toBe(
			"mcp:tedis.read",
		);
		for (const toolName of [
			"open_computer",
			"close_computer",
			"exec",
			"cancel_execution",
			"write",
			"edit",
			"delete",
		]) {
			expect(toolToGranularCapabilityScope(toolName)).toBe("mcp:tedis.write");
		}
	});

	it("classifies aggregate tedi runtime status as a tenant-scoped read", () => {
		expect(toolToCapabilityScope("get_tedi_runtime_status")).toBe("mcp:tedis");
		expect(toolToCapabilityScope("cto__get_tedi_runtime_status")).toBe(
			"mcp:tedis",
		);
		expect(toolToGranularCapabilityScope("get_tedi_runtime_status")).toBe(
			"mcp:tedis.read",
		);
	});

	it("maps tenant self-service connection tools to mcp:settings", () => {
		expect(toolToCapabilityScope("create_mcp_connection_provider")).toBe(
			"mcp:settings",
		);
		expect(toolToCapabilityScope("initiate_connection")).toBe("mcp:settings");
		expect(toolToCapabilityScope("store_connection_api_key")).toBe(
			"mcp:settings",
		);
		// App installation is an app capability, not platform authority.
		expect(toolToGranularCapabilityScope("install_tenant_mcp_app")).toBe(
			"mcp:apps.write",
		);
		expect(toolToCapabilityScope("install_tenant_mcp_apps")).toBe("mcp:apps");
		expect(toolToGranularCapabilityScope("install_tenant_mcp_apps")).toBe(
			"mcp:apps.write",
		);
	});

	it("keeps current-user organization discovery tenant scoped", () => {
		expect(toolToCapabilityScope("list_all_mine")).toBe("mcp:settings");
		expect(toolToGranularCapabilityScope("list_all_mine")).toBe(
			"mcp:settings.read",
		);
	});

	it("classifies the tenant API-key lifecycle without platform authority", () => {
		for (const toolName of ["list_api_keys", "get_expiring_keys"]) {
			expect(toolToGranularCapabilityScope(toolName)).toBe("mcp:settings.read");
		}
		for (const toolName of [
			"create_api_key",
			"rotate_api_key",
			"revoke_api_key",
			"delete_api_key",
		]) {
			expect(toolToGranularCapabilityScope(toolName)).toBe(
				"mcp:settings.admin",
			);
		}
	});

	it("classifies tenant external-agent bootstrap without platform authority", () => {
		expect(
			toolToGranularCapabilityScope("create_external_agent_principal"),
		).toBe("mcp:work.admin");
	});

	it("treats removal of a tedi app assignment as an org-scoped tedi write", () => {
		expect(toolToCapabilityScope("delete_tedi_app_assignments")).toBe(
			"mcp:tedis",
		);
		expect(toolToGranularCapabilityScope("delete_tedi_app_assignments")).toBe(
			"mcp:tedis.write",
		);
	});

	it("treats provider prompt and project maintenance as content writes", () => {
		expect(toolToCapabilityScope("update_prompt")).toBe("mcp:content");
		expect(toolToCapabilityScope("promptwatch_tedix__update_prompt")).toBe(
			"mcp:content",
		);
		expect(toolToGranularCapabilityScope("update_prompt")).toBe(
			"mcp:content.write",
		);
		// The unqualified Tedix work-hierarchy tool keeps its memory scope. Only
		// the private PromptWatch aggregate operation is provider content.
		expect(toolToCapabilityScope("update_project")).toBe("mcp:memory");
		expect(
			toolToCapabilityScope("promptwatch_project_tedix__update_project"),
		).toBe("mcp:content");
		expect(
			toolToGranularCapabilityScope(
				"promptwatch_project_tedix__update_project",
			),
		).toBe("mcp:content.write");
		expect(
			toolToCapabilityScope("promptwatch_project_tedix__move_prompts"),
		).toBe("mcp:content");
		expect(
			toolToGranularCapabilityScope("promptwatch_project_tedix__move_prompts"),
		).toBe("mcp:content.write");
		expect(toolToCapabilityScope("move_prompts")).toBe("mcp:content");
		expect(toolToGranularCapabilityScope("move_prompts")).toBe(
			"mcp:content.admin",
		);
		expect(
			toolToCapabilityScope("promptwatch_project_other__move_prompts"),
		).toBe("mcp:content");
		expect(
			toolToGranularCapabilityScope("promptwatch_project_other__move_prompts"),
		).toBe("mcp:content.admin");
	});

	it("flags only EXPLICIT admin ACCESS_LEVEL_OVERRIDES tools, not the unknown-verb fallback", () => {
		// Explicitly marked admin-tier governance ops.
		expect(isAdminAccessLevelOverrideTool("promote_skill")).toBe(true);
		expect(isAdminAccessLevelOverrideTool("quarantine_skill_proposal")).toBe(
			true,
		);
		expect(isAdminAccessLevelOverrideTool("revoke_skill_run")).toBe(true);
		// Aggregate-prefixed forms resolve through the same override table.
		expect(isAdminAccessLevelOverrideTool("cmo__promote_skill")).toBe(true);
		// Write-tier and read-tier overrides are NOT admin.
		expect(isAdminAccessLevelOverrideTool("apply_role_template")).toBe(false);
		expect(isAdminAccessLevelOverrideTool("run_skill_workflow")).toBe(false);
		// An unknown tool that `toolToAccessLevel` heuristically calls "admin" is
		// NOT an explicit override — the escalation must not catch it.
		expect(toolToAccessLevel("frobnicate_widget")).toBe("admin");
		expect(isAdminAccessLevelOverrideTool("frobnicate_widget")).toBe(false);
	});
});

it("classifies tenant Work configuration without platform authority", () => {
	for (const tool of ["put_work_resource_pool", "put_work_budget_envelope"]) {
		expect(toolToGranularCapabilityScope(tool)).toBe("mcp:settings.admin");
	}
	for (const tool of [
		"list_work_resource_pools",
		"list_work_budget_envelopes",
	]) {
		expect(toolToGranularCapabilityScope(tool)).toBe("mcp:settings.read");
	}
	expect(() => toolToGranularCapabilityScope("unknown_tool")).toThrow(
		/Missing MCP capability mapping/,
	);
});

it("classifies only the Work approval request as an ordinary Work write", () => {
	for (const name of [
		"propose_work_approval",
		"tedix__propose_work_approval",
	]) {
		expect(toolToGranularCapabilityScope(name)).toBe("mcp:work.write");
	}
	expect(toolToGranularCapabilityScope("decide_work_approval")).toBe(
		"mcp:work.admin",
	);
});

it("maps six exact bounded CLI projection names without lending inbox Work authority", () => {
	expect(toolToGranularCapabilityScope("list_work_item_cli_rows")).toBe(
		"mcp:work.read",
	);
	expect(toolToGranularCapabilityScope("get_work_item_checkpoint")).toBe(
		"mcp:work.read",
	);
	expect(toolToGranularCapabilityScope("list_work_attempt_cli_rows")).toBe(
		"mcp:work.read",
	);
	expect(toolToGranularCapabilityScope("list_work_evidence_cli_rows")).toBe(
		"mcp:work.read",
	);
	expect(toolToGranularCapabilityScope("list_work_event_cli_rows")).toBe(
		"mcp:work.read",
	);
	expect(toolToGranularCapabilityScope("list_work_interaction_cli_rows")).toBe(
		"mcp:messaging.read",
	);
});
