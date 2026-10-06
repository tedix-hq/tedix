import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getOrganizationServiceClient } from "../../lib/api";
import {
	demandRateLimitKey,
	demandSourceIntentId,
	demandWorkItemTitle,
	isSyntheticDemand,
	parseDemandIntake,
} from "../../lib/demand-intake";

const MAX_SUBMISSIONS_PER_HOUR = 5;

function json(body: Record<string, unknown>, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
		},
	});
}

async function withinRateLimit(request: Request): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const key = await demandRateLimitKey(ip);
	try {
		const current = Number((await env.SESSION?.get(key)) ?? "0");
		if (current >= MAX_SUBMISSIONS_PER_HOUR) return false;
		await env.SESSION?.put(key, String(current + 1), {
			expirationTtl: 60 * 60,
		});
		return true;
	} catch (error) {
		console.error("[Demand Intake] rate-limit storage failed:", error);
		return true;
	}
}

export const POST: APIRoute = async ({ request }) => {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ success: false, error: "Send a valid JSON request." }, 400);
	}
	const parsed = parseDemandIntake(raw);
	if (!parsed.ok) {
		return json({ success: false, error: parsed.error }, 400);
	}
	const intake = parsed.data;

	// Honeypot: make automation believe it succeeded without creating board work.
	if (intake.website) {
		return json({ success: true, receiptId: "accepted" });
	}
	if (!(await withinRateLimit(request))) {
		return json(
			{
				success: false,
				error: "Too many submissions. Please try again in an hour.",
			},
			429,
		);
	}

	const requiredConfig = {
		organizationId: env.TEDIX_MARKETING_ORG_ID,
		cmoTediId: env.TEDIX_CMO_TEDI_ID,
		objectiveId: env.TEDIX_DEMAND_OBJECTIVE_ID,
		projectId: env.TEDIX_DEMAND_PROJECT_ID,
		parentWorkItemId: env.TEDIX_DEMAND_INTAKE_PARENT_ID,
	};
	if (Object.values(requiredConfig).some((value) => !value)) {
		console.error("[Demand Intake] production work-graph config is incomplete");
		return json(
			{ success: false, error: "Contact intake is temporarily unavailable." },
			503,
		);
	}

	const receivedAt = new Date().toISOString();
	const synthetic = isSyntheticDemand(intake.email);
	const sourceIntentId = await demandSourceIntentId(
		intake.email,
		intake.process,
	);
	const referrer =
		intake.referrer ?? request.headers.get("Referer") ?? undefined;

	try {
		const client = getOrganizationServiceClient(
			env,
			requiredConfig.organizationId,
		);
		const item = await client.workItems.create({
			title: demandWorkItemTitle(intake.process),
			description: [
				`Recurring process: ${intake.process}`,
				`Current owner: ${intake.currentOwner}`,
				`Systems involved: ${intake.systems}`,
				...(intake.context ? [`Additional context: ${intake.context}`] : []),
				`Contact: ${intake.email}`,
				synthetic
					? "Validation: synthetic reserved-domain submission; do not treat as demand."
					: "Consent: contact permitted for this process inquiry.",
			].join("\n"),
			workKind: "operations",
			riskLevel: synthetic ? "low" : "medium",
			priority: synthetic ? "low" : "high",
			accountableOwnerType: "tedi",
			accountableOwnerId: requiredConfig.cmoTediId,
			stewardType: "tedi",
			stewardId: requiredConfig.cmoTediId,
			objectiveId: requiredConfig.objectiveId,
			projectId: requiredConfig.projectId,
			parentWorkItemId: requiredConfig.parentWorkItemId,
			sourceSessionKey: `landing-contact:${intake.utmCampaign ?? "direct"}`,
			sourceIntentId,
			provenance: {
				source: "landing.contact",
				pageUrl: intake.pageUrl ?? null,
				referrer: referrer ?? null,
				receivedAt,
			},
			metadata: {
				intake: {
					email: intake.email,
					process: intake.process,
					currentOwner: intake.currentOwner,
					systems: intake.systems,
					context: intake.context ?? null,
				},
				attribution: {
					source: intake.utmSource ?? null,
					medium: intake.utmMedium ?? null,
					campaign: intake.utmCampaign ?? null,
					content: intake.utmContent ?? null,
					term: intake.utmTerm ?? null,
					referrer: referrer ?? null,
					pageUrl: intake.pageUrl ?? null,
				},
				consent: true,
				synthetic,
				receivedAt,
			},
		});

		return json({
			success: true,
			receiptId: item.id,
			synthetic,
		});
	} catch (error) {
		console.error("[Demand Intake] work-item capture failed:", error);
		return json(
			{
				success: false,
				error:
					"We could not save your process right now. Email hello@tedix.dev instead.",
			},
			502,
		);
	}
};
