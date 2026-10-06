import { expect, it } from "vite-plus/test";
import {
	decodeAiGatewayAttribution,
	encodeAiGatewayAttribution,
} from "./ai-gateway-attribution";
it("keeps an execution and reservation in one flat metadata entry", () => {
	const value = {
		runId: "r",
		workItemId: "w",
		executionId: "e",
		billingReservationId: "b",
	};
	expect(JSON.parse(encodeAiGatewayAttribution(value)).v).toBe(3);
	expect(decodeAiGatewayAttribution(encodeAiGatewayAttribution(value))).toEqual(
		value,
	);
});
it("retains historical envelopes without inventing executions", () => {
	expect(decodeAiGatewayAttribution('{"v":1,"r":"r","w":"w"}')).toEqual({
		runId: "r",
		workItemId: "w",
	});
	expect(decodeAiGatewayAttribution('{"v":3,"r":"r","w":"w"}')).toBeNull();
});
