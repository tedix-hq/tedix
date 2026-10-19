import { createDbClient } from "@tedix/db/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
	authenticatePersonalAgent,
	receivePersonalAgentFinding,
} from "./services/personal-agent-inbound";
import {
	listPersonalAgentOutcomes,
	acknowledgePersonalAgentOutcome,
} from "@tedix/db/queries/personal-agent-outbound";
import { PersonalAgentOutcomeSchema } from "@tedix/api-contract/schemas/personal-agent-inbound";
import * as z from "zod";

export const personalAgentInboundRoutes = new Hono<{
	Bindings: CloudflareEnv;
}>();
personalAgentInboundRoutes.use("*", bodyLimit({ maxSize: 16384 }));
personalAgentInboundRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Content-Type-Options", "nosniff");
	c.header(
		"Content-Security-Policy",
		"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	);
	if (new URL(c.req.url).protocol !== "https:")
		return c.text("HTTPS required", 400);
	await next();
});

const path = "/:orgId/:userId/:enrollmentId";
personalAgentInboundRoutes.get(`${path}/outcomes`, async (c) => {
	const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (!token || token.length < 32 || token.length > 200)
		return c.json({ error: "Invalid or revoked enrollment" }, 401);
	if (!c.env.SECRETS_MASTER_KEY)
		return c.json({ error: "Outcomes unavailable" }, 503);
	const after = Number(c.req.query("after") ?? "0");
	if (!Number.isSafeInteger(after) || after < 0)
		return c.json({ error: "Invalid cursor" }, 400);
	const db = createDbClient(c.env.DB);
	await authenticatePersonalAgent(db, c.env.SECRETS_MASTER_KEY, {
		...c.req.param(),
		token,
	});
	const rows = await listPersonalAgentOutcomes(db, {
		...c.req.param(),
		after,
		limit: 100,
	});
	return c.json({
		outcomes: rows.map((row) => ({
			sequence: row.sequence,
			outcome: PersonalAgentOutcomeSchema.parse(row.payload),
			delivery: {
				workComment: "recorded",
				email: row.emailStatus ?? "not_sent",
				acknowledgedAt: row.acknowledgedAt,
			},
		})),
		nextCursor: rows.at(-1)?.sequence ?? after,
		hasMore: rows.length === 100,
	});
});
personalAgentInboundRoutes.post(`${path}/outcomes/ack`, async (c) => {
	const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (!token || token.length < 32 || token.length > 200)
		return c.json({ error: "Invalid or revoked enrollment" }, 401);
	if (!c.env.SECRETS_MASTER_KEY)
		return c.json({ error: "Outcomes unavailable" }, 503);
	const parsed = z
		.strictObject({
			outcomeId: z.string().min(1).max(500),
			reminderId: z.string().min(1).max(200).optional(),
		})
		.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: "Invalid acknowledgment" }, 400);
	const db = createDbClient(c.env.DB);
	await authenticatePersonalAgent(db, c.env.SECRETS_MASTER_KEY, {
		...c.req.param(),
		token,
	});
	const saved = await acknowledgePersonalAgentOutcome(db, {
		...c.req.param(),
		...parsed.data,
	});
	return saved
		? c.json({
				acknowledged: true,
				reminderSuppression: "unverified_agent_report",
			})
		: c.json({ error: "Outcome not found" }, 404);
});
personalAgentInboundRoutes.get(path, (c) =>
	c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Send a personal-agent finding</title><h1>Send a finding</h1><p>This creates a proposal or FYI for the enrolled person. It never runs an action. Use the credential provided by the owner; this does not sign in as them.</p><form method="post">
<p><label>Enrollment token <input name="token" type="password" autocomplete="off" required maxlength="200"></label></p>
<p><label>External finding ID <input name="externalFindingId" required maxlength="200"></label></p>
<p><label>Title <input name="title" required maxlength="200"></label></p>
<p><label>Finding <textarea name="body" required maxlength="8000"></textarea></label></p>
<p><label>Source reference <input name="evidenceUrl" type="url" required maxlength="2000"></label></p>
<p><label>Type <select name="kind"><option value="fyi">FYI</option><option value="proposal">Proposal</option></select></label></p>
<button type="submit">Submit finding</button></form></html>`),
);

personalAgentInboundRoutes.post(path, async (c) => {
	const type = c.req.header("Content-Type")?.split(";")[0]?.trim();
	if (
		type !== "application/json" &&
		type !== "application/x-www-form-urlencoded"
	)
		return c.json({ error: "Use the browser form or application/json" }, 415);
	const isForm = type === "application/x-www-form-urlencoded";
	// Browser submissions carry the capability in the body, never a URL, cookie or owner session.
	const payload: unknown = isForm
		? await c.req.parseBody()
		: await c.req.json();
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return c.json({ error: "Invalid finding" }, 400);
	const { token: formToken, ...finding } = payload as Record<string, unknown>;
	const token = isForm
		? formToken
		: c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (typeof token !== "string" || token.length > 200 || token.length < 32)
		return c.json({ error: "Invalid or revoked enrollment" }, 401);
	const masterKey = c.env.SECRETS_MASTER_KEY;
	if (!masterKey) return c.json({ error: "Intake unavailable" }, 503);
	const receipt = await receivePersonalAgentFinding(
		createDbClient(c.env.DB),
		masterKey,
		{
			...c.req.param(),
			token,
			finding,
			channel: isForm ? "browser_form" : "webhook",
		},
	);
	if (isForm)
		return c.html(
			`<!doctype html><html lang="en"><meta charset="utf-8"><title>Finding received</title><h1>Finding received</h1><p>${receipt.duplicate ? "Already captured" : "Captured"}. No action was executed.</p><p>Receipt: ${receipt.workItemId}</p><p>Captured at: ${receipt.capturedAt}</p></html>`,
		);
	return c.json(receipt, receipt.duplicate ? 200 : 201);
});

personalAgentInboundRoutes.onError((error, c) => {
	if (error instanceof HTTPException)
		return c.json({ error: error.message }, error.status);
	if (error instanceof SyntaxError)
		return c.json({ error: "Invalid finding" }, 400);
	// Errors may contain submitted credentials. Return a bounded response without logging the error.
	return c.json(
		{ error: "Intake unavailable; retry the same external finding ID" },
		503,
	);
});
