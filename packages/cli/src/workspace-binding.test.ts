import { describe, expect, test } from "bun:test";
import { sessionWorkspaceDrift } from "./workspace-binding";

const BASE = {
	externalSessionKey: "claude-code:abc123",
	resolvedWorkspace: "tedix",
	workspaceWasExplicit: false,
	sessionWorkspaces: ["tedix"],
};

describe("sessionWorkspaceDrift", () => {
	test("allows the workspace the session was started in", () => {
		expect(sessionWorkspaceDrift(BASE)).toBeNull();
	});

	/**
	 * The reported hazard: a concurrent session rewrote the shared selection, so
	 * a bare command resolved somewhere this session never started.
	 */
	test("refuses a session whose workspace drifted underneath it", () => {
		const message = sessionWorkspaceDrift({
			...BASE,
			resolvedWorkspace: "acme-chat-recovery",
		});
		expect(message).not.toBeNull();
		expect(message).toContain("acme-chat-recovery");
		expect(message).toContain("tedix");
		expect(message).toContain("claude-code:abc123");
	});

	test("names a pinned command that would be safe", () => {
		const message = sessionWorkspaceDrift({
			...BASE,
			resolvedWorkspace: "other",
		});
		expect(message).toContain("tedix -w tedix");
	});

	test("reports every workspace the session is bound to, sorted", () => {
		const message = sessionWorkspaceDrift({
			...BASE,
			resolvedWorkspace: "other",
			sessionWorkspaces: ["tedix-codex", "tedix"],
		});
		expect(message).toContain('"tedix", "tedix-codex"');
	});

	test("admits any workspace the session is recorded under", () => {
		expect(
			sessionWorkspaceDrift({
				...BASE,
				resolvedWorkspace: "tedix-codex",
				sessionWorkspaces: ["tedix", "tedix-codex"],
			}),
		).toBeNull();
	});

	/**
	 * Explicit intent is not silent redirection, and `-w` is the documented
	 * mitigation — gating it would break the one safe habit callers already have.
	 */
	test("does not second-guess an explicit --workspace", () => {
		expect(
			sessionWorkspaceDrift({
				...BASE,
				resolvedWorkspace: "acme-chat-recovery",
				workspaceWasExplicit: true,
			}),
		).toBeNull();
	});

	test("stays silent when no Agent-Session is in play", () => {
		for (const key of [undefined, "", "   "]) {
			expect(
				sessionWorkspaceDrift({
					...BASE,
					externalSessionKey: key,
					resolvedWorkspace: "elsewhere",
				}),
			).toBeNull();
		}
	});

	/**
	 * A session that never ran `tedix agent start` has no binding to violate.
	 * Refusing here would break ordinary interactive use that exports a session
	 * id purely for board traceability.
	 */
	test("stays silent when the session is recorded nowhere", () => {
		expect(
			sessionWorkspaceDrift({
				...BASE,
				resolvedWorkspace: "elsewhere",
				sessionWorkspaces: [],
			}),
		).toBeNull();
	});
});
