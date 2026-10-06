/**
 * GOLDEN OUTPUT pins for `kernelGatewayMetadata`.
 *
 * This is the kernel's AI Gateway attribution encoder. Its output is the
 * `cf-aig-metadata` header (and the `env.AI.run` binding `gateway.metadata`)
 * that makes Workers AI spend filterable in gateway logs. A silent change here
 * does not fail anything at runtime — it just makes spend un-attributable — so
 * the contract is pinned byte-for-byte rather than by shape.
 *
 * Unlike the tedi-runtime encoder (`aigMetadataRecord`, which emits only the
 * fields actually present), this one ALWAYS emits `surface`, `sessionKeyHash`,
 * `source` and `attribution`, synthesizing `system:kernel:<source>` correlation
 * when the caller has none. That difference is deliberate and must survive the
 * `@tedix/workers-ai` extraction: the transport serializes a pre-normalized
 * record, the surface tag stays here.
 */

import { describe, expect, it } from "vite-plus/test";
import { kernelGatewayMetadata } from "./gateway-attribution";

describe("kernelGatewayMetadata golden output", () => {
	it("pins the empty case (no context at all)", () => {
		expect(kernelGatewayMetadata()).toEqual({
			surface: "kernel",
			sessionKeyHash: "b1619aca",
			source: "kernel",
			attribution:
				'{"v":1,"r":"system:kernel:kernel","w":"system:kernel:kernel"}',
		});
	});

	it("pins the empty-object case identically to no context", () => {
		expect(kernelGatewayMetadata({})).toEqual(kernelGatewayMetadata());
	});

	it("pins the bare-organization-id string overload", () => {
		expect(kernelGatewayMetadata("org-1")).toEqual({
			surface: "kernel",
			orgId: "org-1",
			sessionKeyHash: "b1619aca",
			source: "kernel",
			attribution:
				'{"v":1,"r":"system:kernel:kernel","w":"system:kernel:kernel"}',
		});
	});

	it("pins a fully populated context", () => {
		expect(
			kernelGatewayMetadata({
				organizationId: "org-1",
				runId: "home-run-1",
				workItemId: "work-item-1",
				sessionKey: "home:conversation-1",
				source: "kernel:route",
				billingReservationId: "billing-reservation-1",
			}),
		).toEqual({
			surface: "kernel",
			orgId: "org-1",
			sessionKeyHash: "ec699729",
			source: "kernel:route",
			attribution:
				'{"v":2,"r":"home-run-1","w":"work-item-1","b":"billing-reservation-1"}',
		});
	});

	it("pins synthesized system correlation when run/work are absent", () => {
		expect(
			kernelGatewayMetadata({
				organizationId: "org-1",
				source: "kernel:conversation-title",
			}),
		).toEqual({
			surface: "kernel",
			orgId: "org-1",
			sessionKeyHash: "58129768",
			source: "kernel:conversation-title",
			attribution:
				'{"v":1,"r":"system:kernel:kernel:conversation-title","w":"system:kernel:kernel:conversation-title"}',
		});
	});

	it("pins runId-only: sessionKey falls back to runId, workItemId synthesizes", () => {
		expect(kernelGatewayMetadata({ runId: "home-run-2" })).toEqual({
			surface: "kernel",
			sessionKeyHash: "4a6fb639",
			source: "kernel",
			attribution: '{"v":1,"r":"home-run-2","w":"system:kernel:kernel"}',
		});
	});

	it("pins whitespace-only fields as absent", () => {
		expect(
			kernelGatewayMetadata({ organizationId: "  ", source: "  " }),
		).toEqual(kernelGatewayMetadata());
	});

	it("never exceeds the Cloudflare five-entry ceiling", () => {
		// The encoder emits at most surface + orgId + sessionKeyHash + source +
		// attribution, so the guard inside it is structurally unreachable. This
		// pins the ceiling itself: adding a sixth emitted field would make the
		// encoder throw at runtime, and that must be a deliberate change.
		expect(
			Object.keys(
				kernelGatewayMetadata({
					organizationId: "org-1",
					runId: "home-run-1",
					workItemId: "work-item-1",
					sessionKey: "home:conversation-1",
					source: "kernel:route",
					billingReservationId: "billing-reservation-1",
				}),
			),
		).toEqual(["surface", "orgId", "sessionKeyHash", "source", "attribution"]);
	});
});
