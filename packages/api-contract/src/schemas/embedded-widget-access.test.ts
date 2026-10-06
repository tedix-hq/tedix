import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_EMBEDDED_WIDGET_ACCESS,
	EmbeddedTediSelectionPolicySchema,
	providerWidgetTediSelection,
	providerWidgetAllowsTedi,
	evaluateEmbeddedWidgetAccess,
	readEmbeddedWidgetAccess,
} from "./embedded-widget-access";

describe("embedded widget audience", () => {
	it("preserves existing installations and fails closed for malformed saved policy", () => {
		expect(readEmbeddedWidgetAccess(null).policy.enabled).toBe(true);
		expect(readEmbeddedWidgetAccess({ widgetAccess: {} }).policy.enabled).toBe(
			false,
		);
	});
	it("makes exclusions override selection and requires a user", () => {
		const config = {
			status: "active" as const,
			revision: 2,
			policy: {
				...DEFAULT_EMBEDDED_WIDGET_ACCESS,
				users: "selected" as const,
				allowedUserIds: ["a", "b"],
				deniedUserIds: ["b"],
			},
		};
		expect(evaluateEmbeddedWidgetAccess(config, "a").allowed).toBe(true);
		expect(evaluateEmbeddedWidgetAccess(config, "b").reason).toBe(
			"user_excluded",
		);
		expect(evaluateEmbeddedWidgetAccess(config, "c").reason).toBe(
			"user_not_selected",
		);
		expect(evaluateEmbeddedWidgetAccess(config, "").reason).toBe(
			"user_required",
		);
		expect(
			evaluateEmbeddedWidgetAccess({ ...config, status: "paused" }, "a")
				.allowed,
		).toBe(false);
		expect(
			evaluateEmbeddedWidgetAccess(
				{ ...config, policy: { ...config.policy, enabled: false } },
				"a",
			).reason,
		).toBe("access_disabled");
	});
});

const workerA = "11111111-1111-4111-8111-111111111111",
	workerB = "22222222-2222-4222-8222-222222222222";
it("preserves a configured primary and rejects malformed explicit selection", () => {
	expect(providerWidgetTediSelection({ primaryTediId: workerA })).toEqual({
		defaultTediId: workerA,
		allowedTediIds: [workerA],
	});
	const selection = { defaultTediId: workerB, allowedTediIds: [workerA] };
	expect(EmbeddedTediSelectionPolicySchema.safeParse(selection).success).toBe(
		false,
	);
	const installation = {
		primaryTediId: workerA,
		provenance: {
			widgetAccess: {
				revision: 1,
				policy: { ...DEFAULT_EMBEDDED_WIDGET_ACCESS, tediSelection: selection },
				updatedAt: "now",
				updatedBy: "admin",
			},
		},
	};
	expect(providerWidgetAllowsTedi(installation, workerA)).toBe(false);
});
it("revoking an allowed worker removes its embedded authority", () => {
	const installation = {
		primaryTediId: workerA,
		provenance: {
			widgetAccess: {
				revision: 1,
				policy: {
					...DEFAULT_EMBEDDED_WIDGET_ACCESS,
					tediSelection: {
						defaultTediId: workerB,
						allowedTediIds: [workerA, workerB],
					},
				},
				updatedAt: "now",
				updatedBy: "admin",
			},
		},
	};
	expect(providerWidgetAllowsTedi(installation, workerB)).toBe(true);
	installation.provenance.widgetAccess.policy.tediSelection = {
		defaultTediId: workerA,
		allowedTediIds: [workerA],
	};
	expect(providerWidgetAllowsTedi(installation, workerB)).toBe(false);
});
