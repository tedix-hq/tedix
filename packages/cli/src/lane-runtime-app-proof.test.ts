import { expect, it } from "bun:test";
import {
	LaneRuntimeAppProofReadError,
	runtimeAppEvidenceUri,
	runtimeAppRevisionProof,
} from "./lane-runtime-app-proof";

const app = {
	workspaceId: "11111111-1111-4111-8111-111111111111",
	gadgetId: "22222222-2222-4222-8222-222222222222",
	revision: 4,
	revisionId: "33333333-3333-4333-8333-333333333333",
};

it.each([
	"valid",
	"legacyDiscovery",
	"unauthorized",
	"wrongEndpoint",
	"unsafeCallable",
	"missingServer",
])(
	"executes discovered runtime app reads without returning source: %s",
	async (scenario) => {
		const readbacks: unknown[] = [];
		const reads: string[] = [];
		const result = runtimeAppRevisionProof(
			app,
			"fictional-work",
			"fictional-attempt",
			async (args) => {
				if (args[0] === "work")
					return {
						data: [
							{
								id: "44444444-4444-4444-8444-444444444444",
								kind: "runtime_app_revision",
								attemptId: "fictional-attempt",
								uri: runtimeAppEvidenceUri(app),
							},
						],
						nextCursor: null,
					};
				const os = {
					get_os_gadget: async (input: unknown) => {
						reads.push("get");
						expect(input).toEqual({
							workspaceId: app.workspaceId,
							gadgetId: app.gadgetId,
						});
						return {
							gadget: {
								id: app.gadgetId,
								workspaceId: app.workspaceId,
								currentRevisionId: app.revisionId,
								status: "active",
								organizationId: "fictional-org",
							},
							currentRevision: {
								id: app.revisionId,
								gadgetId: app.gadgetId,
								revision: app.revision,
								organizationId: "fictional-org",
								manifest: { entry: "tedix:runtime/v1" },
							},
						};
					},
					gadgets_get_code: async (input: unknown) => {
						reads.push("getCode");
						expect(input).toEqual({
							workspaceId: app.workspaceId,
							gadgetId: app.gadgetId,
						});
						return {
							code: {
								revisionId: app.revisionId,
								revision: app.revision,
								codeLength: 20,
								files: {
									...(scenario === "missingServer"
										? {}
										: { "server.js": "fictional tenant server source" }),
									"client.js": "fictional tenant client source",
								},
							},
						};
					},
				};
				const discover = {
					search: async ({ query }: { query: string }) => {
						const results = [
							{
								tool: query,
								callable:
									scenario === "unsafeCallable"
										? "os.get_os_gadget();"
										: `os.${query}`,
								authorized: scenario !== "unauthorized",
								schemaFreshness: {
									sourceRef:
										scenario === "wrongEndpoint"
											? "other/get"
											: `osWorkspaces/gadgets/${query === "get_os_gadget" ? "get" : "getCode"}`,
								},
							},
						];
						return scenario === "legacyDiscovery" ? results : { results };
					},
				};
				const value = await new Function(
					"os",
					"discover",
					`return (${args[1]})();`,
				)(os, discover);
				readbacks.push(value);
				return value;
			},
		);
		if (
			["unauthorized", "wrongEndpoint", "unsafeCallable"].includes(scenario)
		) {
			await expect(result).rejects.toBeInstanceOf(LaneRuntimeAppProofReadError);
			expect(reads).toEqual([]);
		} else {
			expect(await result).toEqual(
				scenario === "missingServer"
					? undefined
					: {
							...app,
							evidenceId: "44444444-4444-4444-8444-444444444444",
							evidenceUri: runtimeAppEvidenceUri(app),
						},
			);
			expect(reads).toEqual(["get", "getCode"]);
			expect(JSON.stringify(readbacks)).not.toContain("fictional tenant");
			expect(JSON.stringify(readbacks)).not.toContain('"files"');
		}
	},
);
