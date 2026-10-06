import { describe, expect, it } from "vite-plus/test";
import type {
	AppGatingMetadata,
	OrgState,
} from "@tedix/api-contract/schemas/app-gating";
import { checkAppEligibility } from "./app-gating";

const metadata: AppGatingMetadata = {
	tedix: {
		requires: { entitlements: ["browser-runtime"] },
		provides: {
			tools: [{ name: "browse", description: "Browse", inputSchema: {} }],
		},
		gating: { mode: "strict" },
		display: { category: "browser", tags: [] },
	},
};

function org(entitlements: string[]): OrgState {
	return {
		orgId: "org-1",
		plan: "starter",
		entitlements,
		connectors: [],
		features: [],
		installedTools: [],
	};
}

describe("app gating runtime entitlements", () => {
	it("admits an app with its named active grant", () => {
		expect(
			checkAppEligibility(metadata, org(["browser-runtime"])),
		).toMatchObject({
			eligible: true,
			availableTools: ["browse"],
		});
	});

	it("fails closed with an entitlement-specific requirement", () => {
		expect(checkAppEligibility(metadata, org([]))).toMatchObject({
			eligible: false,
			missing: [{ type: "entitlement", key: "browser-runtime" }],
		});
	});
});
