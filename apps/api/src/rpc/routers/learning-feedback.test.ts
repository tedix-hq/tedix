import { describe, expect, it } from "vite-plus/test";
import {
	canAccessLearningEvent,
	isHumanLearningReviewer,
	learningScopeCanNominateSubject,
	resolveLearningActor,
	resolveLearningScope,
} from "./learning-feedback";

describe("learning feedback identity and scope", () => {
	it("derives personal and organization scopes instead of trusting caller ids", () => {
		expect(
			resolveLearningScope({
				kind: "personal",
				organizationId: "org-1",
				actorId: "user-1",
			}),
		).toBe("user-1");
		expect(
			resolveLearningScope({
				kind: "organization",
				organizationId: "org-1",
				actorId: "user-1",
			}),
		).toBe("org-1");
	});

	it("binds tedi scope to the selected tedi and rejects a mismatch", () => {
		expect(
			resolveLearningScope({
				kind: "tedi",
				organizationId: "org-1",
				actorId: "user-1",
				tediId: "tedi-1",
			}),
		).toBe("tedi-1");
		expect(() =>
			resolveLearningScope({
				kind: "tedi",
				requestedId: "tedi-2",
				organizationId: "org-1",
				actorId: "user-1",
				tediId: "tedi-1",
			}),
		).toThrow(/must match/);
	});

	it("uses the authenticated principal as event actor", () => {
		expect(
			resolveLearningActor({
				authType: "user",
				user: { sub: "user-1" },
			}),
		).toEqual({ actorType: "user", actorId: "user-1" });
		expect(
			resolveLearningActor({ authType: "tedi", tediId: "tedi-1" }),
		).toEqual({
			actorType: "tedi",
			actorId: "tedi-1",
		});
		expect(
			resolveLearningActor({
				authType: "service-binding",
				descopeUserId: "acting-user-1",
				serviceAccount: { clientId: "mcp-service" },
			}),
		).toEqual({ actorType: "user", actorId: "acting-user-1" });
	});

	it("keeps final improvement approval behind a direct human session", () => {
		expect(
			isHumanLearningReviewer({
				authType: "user",
				user: { sub: "user-1" } as never,
			}),
		).toBe(true);
		expect(
			isHumanLearningReviewer({
				authType: "service-binding",
				user: undefined,
			}),
		).toBe(false);
		expect(isHumanLearningReviewer({ authType: "tedi", user: undefined })).toBe(
			false,
		);
	});

	it("keeps personal learning events private to their authenticated actor", () => {
		expect(
			canAccessLearningEvent("user-1", {
				scopeKind: "personal",
				scopeId: "user-1",
			}),
		).toBe(true);
		expect(
			canAccessLearningEvent("user-2", {
				scopeKind: "personal",
				scopeId: "user-1",
			}),
		).toBe(false);
		expect(
			canAccessLearningEvent(null, {
				scopeKind: "organization",
				scopeId: "org-1",
			}),
		).toBe(true);
	});

	it("prevents scoped evidence from nominating a wider unrelated subject", () => {
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "personal",
				scopeId: "user-1",
				tediId: "tedi-1",
				subjectKind: "memory_fact",
				subjectId: "fact-1",
				actorType: "user",
				actorId: "user-1",
			}),
		).toBe(true);
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "personal",
				scopeId: "user-1",
				tediId: "tedi-1",
				subjectKind: "workflow",
				subjectId: "workflow-1",
				actorType: "user",
				actorId: "user-1",
			}),
		).toBe(false);
		expect(
			learningScopeCanNominateSubject({
				scopeKind: "workflow",
				scopeId: "workflow-1",
				tediId: "tedi-1",
				subjectKind: "workflow",
				subjectId: "workflow-2",
				actorType: "tedi",
				actorId: "tedi-1",
			}),
		).toBe(false);
	});
});
