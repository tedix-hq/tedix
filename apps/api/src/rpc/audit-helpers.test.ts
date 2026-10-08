/**
 * auditActor — unit tests for the shared actor-resolution helper.
 *
 * Added alongside the capability-mutation gate fix
 * (decisions/agent-capability-mutation-gate.md): before this change,
 * `auditActor` had no branch for a tedi-authenticated caller
 * (`context.tediId` set), so every tedi-driven audited action collapsed into
 * `actorType: "service"` / `actorId: "service-binding"` (or "anonymous"),
 * making it impossible to tell which tedi performed a given action from the
 * audit trail alone.
 */

import { describe, expect, it } from "vite-plus/test";
import { auditActor } from "./audit-helpers";

describe("auditActor", () => {
	it("resolves a human caller to actorType user", () => {
		const result = auditActor({
			user: { sub: "user-1", email: "a@example.com" } as never,
		});
		expect(result.actorType).toBe("user");
		expect(result.actorId).toBe("user-1");
	});

	it("prefers mapped canonical user and service principals", () => {
		expect(
			auditActor({
				userId: "canonical-user-1",
				user: { sub: "descope-user-1" } as never,
			}).actorId,
		).toBe("canonical-user-1");
		expect(
			auditActor({
				serviceAccount: {
					clientId: "descope-client-1",
					canonicalPrincipalId: "canonical-service-1",
				},
			}).actorId,
		).toBe("canonical-service-1");
	});

	it("resolves a tedi-authenticated caller to actorType tedi, actorId = tediId", () => {
		const result = auditActor({ tediId: "tedi-cto-1", authType: "tedi" });
		expect(result.actorType).toBe("tedi");
		expect(result.actorId).toBe("tedi-cto-1");
	});

	it("prefers tediId over a generic serviceAccount when both happen to be present", () => {
		const result = auditActor({
			tediId: "tedi-cto-1",
			serviceAccount: { clientId: "mcp-service" },
			authType: "tedi",
		});
		expect(result.actorType).toBe("tedi");
		expect(result.actorId).toBe("tedi-cto-1");
	});

	it("resolves a gateway external agent to actorType external_agent", () => {
		const result = auditActor({
			authType: "service-binding",
			externalAgentPrincipalId: "principal-1",
			externalAgentSessionId: "session-1",
			gatewayEndUserId: "descope-user-9",
		});
		expect(result.actorType).toBe("external_agent");
		expect(result.actorId).toBe("principal-1");
		expect(result.actorMetadata).toMatchObject({
			sessionId: "session-1",
			gatewayEndUserId: "descope-user-9",
		});
	});

	it("prefers the external-agent principal over a forwarded tedi header", () => {
		// Matches `resolveCreator`, the OS domain's accountability precedence: the
		// agent, not the tedi whose namespace it addressed, made the write.
		const result = auditActor({
			authType: "service-binding",
			externalAgentPrincipalId: "principal-1",
			tediId: "tedi-cto-1",
		});
		expect(result.actorType).toBe("external_agent");
		expect(result.actorId).toBe("principal-1");
	});

	it("resolves an operator-issued API key to actorType api_key", () => {
		const result = auditActor({ apiKey: { id: "key-1", name: "ci" } });
		expect(result.actorType).toBe("api_key");
		expect(result.actorId).toBe("key-1");
	});

	it("resolves a generic M2M service account to actorType m2m", () => {
		const result = auditActor({
			serviceAccount: { clientId: "workflow-runner" },
		});
		expect(result.actorType).toBe("m2m");
		expect(result.actorId).toBe("workflow-runner");
	});

	it("resolves a bare service-binding caller (no tediId, no serviceAccount) to actorType service", () => {
		const result = auditActor({ authType: "service-binding" });
		expect(result.actorType).toBe("service");
	});

	it("falls back to anonymous when nothing identifies the caller", () => {
		const result = auditActor({});
		expect(result.actorType).toBe("anonymous");
	});
});
