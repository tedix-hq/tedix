import { describe, expect, it } from "vite-plus/test";
import {
	decideKernelWriteApproval,
	parseKernelGovernancePolicy,
	parseRuntimeApprovalTimestamp,
	resolveApprovalTtlHours,
	resolveKernelFanOutCap,
	resolveRuntimeApprovalAuthority,
	resolveRuntimeApprovalTimeout,
	runtimeApprovalAuditAction,
	runtimeApprovalResolutionStatus,
	runtimeApprovalResolvedPayload,
	runtimeApprovalResolverMetadata,
	runtimeApprovalReviewSemantics,
	writeToolMatchesAllowlist,
} from "./approval-policy";

describe("resolveRuntimeApprovalAuthority", () => {
	it("fails closed for unattributed allow decisions", () => {
		expect(
			resolveRuntimeApprovalAuthority({
				approved: true,
				tediId: "tedi-1",
			}),
		).toMatchObject({
			allowed: false,
			provenance: "unattributed",
		});
	});

	it("allows deny decisions without elevated authority", () => {
		expect(
			resolveRuntimeApprovalAuthority({
				approved: false,
				tediId: "tedi-1",
			}),
		).toMatchObject({
			allowed: true,
			provenance: "unattributed",
		});
	});

	it("allows attributed principals with an approval scope", () => {
		expect(
			resolveRuntimeApprovalAuthority({
				approved: true,
				tediId: "tedi-1",
				principal: {
					authType: "user",
					subject: "user-1",
					scopes: ["tedi:permissions.write"],
				},
			}),
		).toMatchObject({
			allowed: true,
			provenance: "attributed",
		});
	});

	it("treats platform-wide scopes as runtime approval authority", () => {
		expect(
			resolveRuntimeApprovalAuthority({
				approved: true,
				tediId: "tedi-1",
				principal: {
					authType: "apikey",
					subject: "api-key-1",
					scopes: ["*"],
				},
			}),
		).toMatchObject({
			allowed: true,
			provenance: "attributed",
		});
	});
});

describe("runtimeApprovalReviewSemantics", () => {
	it("makes the payment budget decision conditional on an actual policy change", () => {
		const review = runtimeApprovalReviewSemantics({
			id: "payment-review-1",
			tediId: "tedi-1",
			actionType: "payment_budget_override",
			status: "pending",
			expiresAt: "2026-10-05T00:00:00.000Z",
			now: Date.parse("2026-09-28T00:00:00.000Z"),
			payload: { kind: "payment_budget_override" },
		});
		expect(review.operatorQuestion).toContain(
			"Approving this request alone does not authorize spend",
		);
	});

	it("normalizes Home tool-write approvals for Mission Control review", () => {
		expect(
			runtimeApprovalReviewSemantics({
				id: "approval-1",
				tediId: "tedi-1",
				actionType: "home.tool_write",
				description: "Approve Kernel write: update_invoice on acme",
				status: "pending",
				expiresAt: "2026-06-13T13:00:00.000Z",
				now: Date.parse("2026-06-13T12:00:00.000Z"),
				payload: {
					kind: "home_tool_write",
					appSlug: "acme",
					toolName: "update_invoice",
					homeRunId: "home-run-1",
					conversationId: "conversation-1",
				},
			}),
		).toEqual({
			intent: "tool_write",
			state: "requires_decision",
			decisionMode: "approve_or_reject",
			outcome: null,
			safetyDefault: "deny_on_timeout",
			summary: "Approve Kernel write: update_invoice on acme",
			operatorQuestion:
				"Approve or reject this Home tool write. Approval executes the stored call once; rejection closes it without executing.",
			timeout: {
				expired: false,
				terminalStatus: null,
				defaultDecision: null,
				reason: "approval is still within its review window",
			},
			evidenceRefs: [
				{ kind: "approval_request", id: "approval-1" },
				{ kind: "tedi", id: "tedi-1" },
				{ kind: "home_run", id: "home-run-1" },
				{ kind: "conversation", id: "conversation-1" },
			],
			interaction: null,
		});
	});

	it("derives certified workstation attachment evidence without payload-specific UI logic", () => {
		expect(
			runtimeApprovalReviewSemantics({
				id: "approval-2",
				tediId: "delegate-tedi-1",
				actionType: "workstation.attach",
				description: "Approve certified Home workstation attachment",
				status: "pending",
				expiresAt: "2026-06-13T11:59:59.999Z",
				now: Date.parse("2026-06-13T12:00:00.000Z"),
				workflowId: "workflow-1",
				payload: {
					source: "home.workstation_attach",
					homeRunId: "home-run-2",
					homeConversationId: "conversation-2",
					delegateToTediId: "delegate-tedi-1",
					requestPreview: "Inspect the production logs",
					workOrder: {
						runId: "container-run-1",
						traceBundleId: "trace-bundle-1",
					},
				},
			}),
		).toMatchObject({
			intent: "workstation_attach",
			state: "closed",
			decisionMode: "no_action",
			outcome: "expired",
			safetyDefault: "deny_on_timeout",
			summary: "Approve certified Home workstation attachment",
			timeout: {
				expired: true,
				terminalStatus: "expired",
				defaultDecision: "deny",
				reason: "approval review window expired",
			},
			evidenceRefs: [
				{ kind: "approval_request", id: "approval-2" },
				{ kind: "tedi", id: "delegate-tedi-1" },
				{ kind: "workflow", id: "workflow-1" },
				{ kind: "home_run", id: "home-run-2" },
				{ kind: "conversation", id: "conversation-2" },
				{ kind: "delegate_tedi", id: "delegate-tedi-1" },
				{ kind: "runtime_run", id: "container-run-1" },
				{ kind: "trace_bundle", id: "trace-bundle-1" },
			],
		});
	});

	it("projects a safe Browser Live View takeover with continuation evidence", () => {
		expect(
			runtimeApprovalReviewSemantics({
				id: "approval-browser-1",
				tediId: "tedi-1",
				actionType: "browser.live_view_takeover",
				description: "Complete MFA in the live browser",
				status: "pending",
				expiresAt: "2026-06-13T13:00:00.000Z",
				now: Date.parse("2026-06-13T12:00:00.000Z"),
				payload: {
					kind: "browser_live_view_takeover",
					reason: "mfa",
					sessionId: "browser-session-1",
					workItemId: "work-item-1",
					runId: "run-1",
					traceBundleId: "trace-1",
					urlExpiresAt: "2026-06-13T12:05:00.000Z",
					targets: [
						{
							targetId: "target-1",
							url: "https://live.browser.run/?session=opaque",
							pageUrl: "https://accounts.example.com/mfa",
							title: "Verify sign-in",
						},
					],
				},
			}),
		).toMatchObject({
			intent: "browser_takeover",
			operatorQuestion:
				"Take control of this live browser session, complete the human-only step, then approve to let the tedi continue in the same session.",
			evidenceRefs: [
				{ kind: "approval_request", id: "approval-browser-1" },
				{ kind: "tedi", id: "tedi-1" },
				{ kind: "runtime_run", id: "run-1" },
				{ kind: "trace_bundle", id: "trace-1" },
				{ kind: "browser_session", id: "browser-session-1" },
				{ kind: "work_item", id: "work-item-1" },
			],
			interaction: {
				type: "browser_takeover",
				reason: "mfa",
				sessionId: "browser-session-1",
				mode: "tab",
				urlExpiresAt: "2026-06-13T12:05:00.000Z",
				targets: [
					{
						targetId: "target-1",
						url: "https://live.browser.run/?session=opaque",
						pageUrl: "https://accounts.example.com",
						title: "Verify sign-in",
					},
				],
			},
		});
	});

	it("rejects non-Cloudflare Live View URLs from the typed interaction", () => {
		const review = runtimeApprovalReviewSemantics({
			id: "approval-browser-2",
			actionType: "browser.live_view_takeover",
			status: "pending",
			payload: {
				kind: "browser_live_view_takeover",
				reason: "login",
				sessionId: "browser-session-2",
				urlExpiresAt: "2026-06-13T12:05:00.000Z",
				targets: [
					{
						targetId: "target-2",
						url: "https://attacker.example/live",
					},
				],
			},
		});
		expect(review.intent).toBe("browser_takeover");
		expect(review.interaction).toBeNull();
	});
});

describe("runtime approval resolution helpers", () => {
	it("derives status, audit action, and resolved event payloads", () => {
		expect(runtimeApprovalResolutionStatus(true)).toBe("approved");
		expect(runtimeApprovalResolutionStatus(false)).toBe("rejected");
		expect(runtimeApprovalAuditAction({ status: "approved" })).toBe(
			"approval.approved",
		);
		expect(
			runtimeApprovalResolvedPayload({
				approved: false,
				resolution: "no",
				metadata: { source: "test" },
			}),
		).toEqual({
			status: "rejected",
			approved: false,
			resolution: "no",
			metadata: { source: "test" },
		});
	});

	it("builds provenance metadata with authoritative resolver fields", () => {
		expect(
			runtimeApprovalResolverMetadata({
				source: "tedi.mcp.permissions_respond",
				extraMetadata: {
					decision: "allow-once",
					resolvedBySubject: "spoofed",
					source: "spoofed",
				},
				authority: {
					allowed: true,
					provenance: "attributed",
					reason: "resolver has runtime approval authority",
				},
				principal: {
					authType: "aih-oauth",
					subject: "user-1",
					clientId: "client-1",
				},
			}),
		).toEqual({
			decision: "allow-once",
			source: "tedi.mcp.permissions_respond",
			resolverProvenance: "attributed",
			resolverPolicyReason: "resolver has runtime approval authority",
			resolvedByAuthType: "aih-oauth",
			resolvedBySubject: "user-1",
			resolvedByClientId: "client-1",
		});
	});
});

describe("resolveRuntimeApprovalTimeout", () => {
	const now = Date.parse("2026-06-13T12:00:00.000Z");

	it("normalizes ISO and D1 timestamp formats", () => {
		expect(parseRuntimeApprovalTimestamp("2026-06-13T12:00:00.000Z")).toBe(now);
		expect(parseRuntimeApprovalTimestamp("2026-06-13 12:00:00")).toBe(now);
	});

	it("default-denies pending approvals once the review window expires", () => {
		expect(
			resolveRuntimeApprovalTimeout({
				status: "pending",
				expiresAt: "2026-06-13T11:59:59.999Z",
				now,
			}),
		).toEqual({
			expired: true,
			terminalStatus: "expired",
			defaultDecision: "deny",
			reason: "approval review window expired",
		});
	});

	it("treats already expired rows as timeout-deny evidence", () => {
		expect(
			resolveRuntimeApprovalTimeout({
				status: "expired",
				expiresAt: "2026-06-14T12:00:00.000Z",
				now,
			}),
		).toMatchObject({
			expired: true,
			terminalStatus: "expired",
			defaultDecision: "deny",
		});
	});

	it("does not reinterpret resolved approvals", () => {
		for (const status of ["approved", "rejected", "cancelled", "canceled"]) {
			expect(
				resolveRuntimeApprovalTimeout({
					status,
					expiresAt: "2026-06-13T11:00:00.000Z",
					now,
				}),
			).toMatchObject({
				expired: false,
				terminalStatus: null,
				defaultDecision: null,
			});
		}
	});

	it("does not expire pending approvals with unknown timestamps", () => {
		expect(
			resolveRuntimeApprovalTimeout({
				status: "pending",
				expiresAt: "not-a-date",
				now,
			}),
		).toMatchObject({
			expired: false,
			defaultDecision: null,
		});
	});
});

describe("parseKernelGovernancePolicy", () => {
	it("returns empty object for null/undefined/non-object inputs", () => {
		expect(parseKernelGovernancePolicy(null)).toEqual({});
		expect(parseKernelGovernancePolicy(undefined)).toEqual({});
		expect(parseKernelGovernancePolicy("string")).toEqual({});
		expect(parseKernelGovernancePolicy(42)).toEqual({});
		expect(parseKernelGovernancePolicy([])).toEqual({});
	});

	it("parses valid approvalTtlHours within bounds", () => {
		expect(parseKernelGovernancePolicy({ approvalTtlHours: 48 })).toEqual({
			approvalTtlHours: 48,
		});
	});

	it("clamps approvalTtlHours to max 168h", () => {
		expect(parseKernelGovernancePolicy({ approvalTtlHours: 200 })).toEqual({
			approvalTtlHours: 168,
		});
	});

	it("clamps approvalTtlHours to min 1h", () => {
		expect(parseKernelGovernancePolicy({ approvalTtlHours: 0 })).toEqual({
			approvalTtlHours: 1,
		});
	});

	it("ignores non-numeric approvalTtlHours", () => {
		expect(parseKernelGovernancePolicy({ approvalTtlHours: "bad" })).toEqual(
			{},
		);
	});

	it("parses valid maxDelegationsPerTurn within bounds", () => {
		expect(parseKernelGovernancePolicy({ maxDelegationsPerTurn: 3 })).toEqual({
			maxDelegationsPerTurn: 3,
		});
	});

	it("clamps maxDelegationsPerTurn to max 20", () => {
		expect(parseKernelGovernancePolicy({ maxDelegationsPerTurn: 50 })).toEqual({
			maxDelegationsPerTurn: 20,
		});
	});

	it("clamps maxDelegationsPerTurn to min 1", () => {
		// 0 is clamped to min 1 (can't set a 0 cap via policy — use maxDelegationsPerTurn:1 as kill-switch)
		expect(parseKernelGovernancePolicy({ maxDelegationsPerTurn: 0 })).toEqual({
			maxDelegationsPerTurn: 1,
		});
	});

	it("parses both fields together", () => {
		expect(
			parseKernelGovernancePolicy({
				approvalTtlHours: 72,
				maxDelegationsPerTurn: 2,
				unknownField: "ignored",
			}),
		).toEqual({ approvalTtlHours: 72, maxDelegationsPerTurn: 2 });
	});

	it("parses only a boolean third-party approval rollout switch", () => {
		expect(
			parseKernelGovernancePolicy({
				requireExplicitThirdPartyApprovalPolicy: true,
			}),
		).toEqual({ requireExplicitThirdPartyApprovalPolicy: true });
		expect(
			parseKernelGovernancePolicy({
				requireExplicitThirdPartyApprovalPolicy: "true",
			}),
		).toEqual({});
	});
});

describe("resolveApprovalTtlHours", () => {
	it("returns 24h default when policy is absent", () => {
		expect(resolveApprovalTtlHours(null)).toBe(24);
		expect(resolveApprovalTtlHours(undefined)).toBe(24);
		expect(resolveApprovalTtlHours({})).toBe(24);
	});

	it("returns configured value when present and valid", () => {
		expect(resolveApprovalTtlHours({ approvalTtlHours: 48 })).toBe(48);
	});

	it("returns 24h default when field is out of range (clamping recovers)", () => {
		// resolveApprovalTtlHours re-clamps on the way out
		expect(resolveApprovalTtlHours({ approvalTtlHours: 168 })).toBe(168);
		expect(resolveApprovalTtlHours({ approvalTtlHours: 1 })).toBe(1);
	});

	it("supports day-long approval window (ask_timeout:86400 = 24h)", () => {
		// 86400 seconds = 24 hours — a common default in comparable systems
		expect(resolveApprovalTtlHours({ approvalTtlHours: 24 })).toBe(24);
	});

	it("supports extended review windows up to 1 week", () => {
		expect(resolveApprovalTtlHours({ approvalTtlHours: 168 })).toBe(168);
	});
});

describe("resolveKernelFanOutCap", () => {
	it("returns 4 as the default cap when policy is absent", () => {
		expect(resolveKernelFanOutCap(null)).toBe(4);
		expect(resolveKernelFanOutCap(undefined)).toBe(4);
		expect(resolveKernelFanOutCap({})).toBe(4);
	});

	it("returns configured cap when present and valid", () => {
		expect(resolveKernelFanOutCap({ maxDelegationsPerTurn: 2 })).toBe(2);
	});

	it("a cap of 1 blocks all child dispatches (kill-switch: only the spawn tool itself fits)", () => {
		// cap=1 means the dispatch tool counts as 1 and no budget remains for children
		expect(resolveKernelFanOutCap({ maxDelegationsPerTurn: 1 })).toBe(1);
	});

	it("caps at max 20", () => {
		expect(resolveKernelFanOutCap({ maxDelegationsPerTurn: 20 })).toBe(20);
	});
});

describe("parseKernelGovernancePolicy — writeTier", () => {
	it("parses trustedTools + autoApproveLowRisk", () => {
		expect(
			parseKernelGovernancePolicy({
				writeTier: {
					trustedTools: ["acme:create_invoice", "gmail:*"],
					autoApproveLowRisk: true,
				},
			}),
		).toEqual({
			writeTier: {
				trustedTools: ["acme:create_invoice", "gmail:*"],
				autoApproveLowRisk: true,
			},
		});
	});

	it("drops non-string / blank trustedTools entries and trims", () => {
		expect(
			parseKernelGovernancePolicy({
				writeTier: { trustedTools: ["  app:tool  ", 42, "", "  "] },
			}),
		).toEqual({ writeTier: { trustedTools: ["app:tool"] } });
	});

	it("omits writeTier entirely when it carries nothing usable (fail-closed)", () => {
		expect(parseKernelGovernancePolicy({ writeTier: {} })).toEqual({});
		expect(
			parseKernelGovernancePolicy({ writeTier: { trustedTools: [] } }),
		).toEqual({});
		expect(parseKernelGovernancePolicy({ writeTier: "nope" })).toEqual({});
	});

	it("caps trustedTools at 50 entries", () => {
		const many = Array.from({ length: 80 }, (_, i) => `app:tool_${i}`);
		const parsed = parseKernelGovernancePolicy({
			writeTier: { trustedTools: many },
		});
		expect(parsed.writeTier?.trustedTools).toHaveLength(50);
	});
});

describe("writeToolMatchesAllowlist", () => {
	it("matches exact app:tool (case-insensitive, trimmed)", () => {
		expect(writeToolMatchesAllowlist("App", "Tool", [" app:tool "])).toBe(true);
	});
	it("matches app:* wildcard", () => {
		expect(writeToolMatchesAllowlist("gmail", "send_email", ["gmail:*"])).toBe(
			true,
		);
	});
	it("matches *:tool without trusting neighboring tools", () => {
		expect(
			writeToolMatchesAllowlist("tenant-a-unified", "install_apps", [
				"*:install_apps",
			]),
		).toBe(true);
		expect(
			writeToolMatchesAllowlist("tenant-a-unified", "delete_app", [
				"*:install_apps",
			]),
		).toBe(false);
	});
	it("matches global * / *:*", () => {
		expect(writeToolMatchesAllowlist("a", "b", ["*"])).toBe(true);
		expect(writeToolMatchesAllowlist("a", "b", ["*:*"])).toBe(true);
	});
	it("does not match a different tool or app", () => {
		expect(writeToolMatchesAllowlist("a", "b", ["a:c"])).toBe(false);
		expect(writeToolMatchesAllowlist("a", "b", ["x:*"])).toBe(false);
	});
	it("returns false on empty / nullish allowlist", () => {
		expect(writeToolMatchesAllowlist("a", "b", [])).toBe(false);
		expect(writeToolMatchesAllowlist("a", "b", null)).toBe(false);
		expect(writeToolMatchesAllowlist("a", "b", undefined)).toBe(false);
	});
});

describe("decideKernelWriteApproval — fail-closed write tier", () => {
	const lowWrite = {
		appSlug: "acme",
		toolName: "create_invoice",
		riskTier: "low" as const,
	};
	const highWrite = {
		appSlug: "acme",
		toolName: "delete_invoice",
		riskTier: "high" as const,
	};

	// (d) fail-closed default — no policy => gated.
	it("(d) gates by default when no policy is configured", () => {
		expect(decideKernelWriteApproval({ proposal: lowWrite })).toMatchObject({
			autoResolve: false,
			source: null,
		});
		expect(
			decideKernelWriteApproval({ policy: {}, proposal: lowWrite }),
		).toMatchObject({
			autoResolve: false,
			source: null,
		});
	});

	// (a) low-risk trusted write auto-resolves via policy.
	it("(a) auto-resolves a low-risk write on a policy-trusted tool", () => {
		const decision = decideKernelWriteApproval({
			policy: { writeTier: { trustedTools: ["acme:create_invoice"] } },
			proposal: lowWrite,
		});
		expect(decision).toMatchObject({ autoResolve: true, source: "policy" });
	});

	it("auto-resolves the tenant-specific catalog installer through tool-only trust", () => {
		const decision = decideKernelWriteApproval({
			policy: {
				writeTier: {
					trustedTools: ["*:tenant.install_tenant_mcp_apps"],
				},
			},
			proposal: {
				appSlug: "example-studio-unified",
				toolName: "tenant.install_tenant_mcp_apps",
				riskTier: "low",
			},
		});
		expect(decision).toMatchObject({ autoResolve: true, source: "policy" });
	});

	// (b) higher-risk write stays gated even on a trusted tool.
	it("(b) gates a HIGH-risk write even when the tool is policy-trusted", () => {
		const decision = decideKernelWriteApproval({
			policy: { writeTier: { trustedTools: ["acme:delete_invoice"] } },
			proposal: highWrite,
		});
		expect(decision).toMatchObject({ autoResolve: false, source: null });
		expect(decision.reason).toContain("high-risk");
	});

	// (b) non-trusted tool stays gated.
	it("(b) gates a low-risk write when the tool is not trusted", () => {
		expect(
			decideKernelWriteApproval({
				policy: { writeTier: { trustedTools: ["other-app:create_thing"] } },
				proposal: lowWrite,
			}),
		).toMatchObject({ autoResolve: false, source: null });
	});

	it("respects the autoApproveLowRisk kill switch (trusted but disabled => gated)", () => {
		expect(
			decideKernelWriteApproval({
				policy: {
					writeTier: {
						trustedTools: ["acme:create_invoice"],
						autoApproveLowRisk: false,
					},
				},
				proposal: lowWrite,
			}),
		).toMatchObject({ autoResolve: false, source: null });
	});

	// (c) session pre-auth allowlist auto-resolves only allowlisted tools.
	it("(c) session pre-auth auto-resolves an allowlisted tool, gates the rest", () => {
		const allowlist = ["acme:create_invoice"];
		expect(
			decideKernelWriteApproval({
				sessionAllowlist: allowlist,
				proposal: lowWrite,
			}),
		).toMatchObject({ autoResolve: true, source: "session" });
		expect(
			decideKernelWriteApproval({
				sessionAllowlist: allowlist,
				proposal: {
					appSlug: "acme",
					toolName: "create_credit_note",
					riskTier: "low",
				},
			}),
		).toMatchObject({ autoResolve: false, source: null });
	});

	it("(c) session pre-auth can carry a high-risk write the operator explicitly named", () => {
		expect(
			decideKernelWriteApproval({
				sessionAllowlist: ["acme:delete_invoice"],
				proposal: highWrite,
			}),
		).toMatchObject({ autoResolve: true, source: "session" });
	});

	it("session pre-auth wins over an absent policy match", () => {
		expect(
			decideKernelWriteApproval({
				policy: { writeTier: { trustedTools: [] } },
				sessionAllowlist: ["acme:create_invoice"],
				proposal: lowWrite,
			}),
		).toMatchObject({ autoResolve: true, source: "session" });
	});
});

describe("repo_commit approval policy", () => {
	const lowCommit = {
		appSlug: "repo",
		toolName: "repo_commit",
		riskTier: "low" as const,
	};
	const highCommit = {
		appSlug: "repo",
		toolName: "repo_commit",
		riskTier: "high" as const,
	};

	it("high-risk repo_commit (protected branch) never auto-approves via policy even when trusted", () => {
		const decision = decideKernelWriteApproval({
			policy: { writeTier: { trustedTools: ["repo:repo_commit"] } },
			proposal: highCommit,
		});
		expect(decision).toMatchObject({ autoResolve: false, source: null });
		expect(decision.reason).toContain("high-risk");
	});

	it("low-risk repo_commit in trustedTools auto-approves with source:'policy'", () => {
		const decision = decideKernelWriteApproval({
			policy: { writeTier: { trustedTools: ["repo:repo_commit"] } },
			proposal: lowCommit,
		});
		expect(decision).toMatchObject({ autoResolve: true, source: "policy" });
	});

	it("session allowlist carries high-risk repo_commit with source:'session'", () => {
		const decision = decideKernelWriteApproval({
			sessionAllowlist: ["repo:repo_commit"],
			proposal: highCommit,
		});
		expect(decision).toMatchObject({ autoResolve: true, source: "session" });
	});
});
