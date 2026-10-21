import { expect, it } from "vite-plus/test";
import { GetDecisionContextOutputSchema } from "@tedix/api-contract/schemas/decision-graph";
import {
	decisionGraphFixture,
	GITHUB_CARD_ID,
	GITHUB_DECISION_CONTEXT,
} from "./decision-graph-fixture";
import { handleLocalRpc } from "./local-fixtures";

it("serves the GitHub chain through the fixture RPC with the real output contract", () => {
	const result = handleLocalRpc("/api/rpc/decisionGraph/getContext", "GET", {
		json: { cardId: GITHUB_CARD_ID, maxHops: 4 },
	});
	expect(result?.status).toBe(200);
	const body = result?.body as { json: unknown };
	expect(GetDecisionContextOutputSchema.parse(body.json)).toEqual(
		GITHUB_DECISION_CONTEXT,
	);
	expect(decisionGraphFixture("unlinked").context.chain).toEqual([]);
});
