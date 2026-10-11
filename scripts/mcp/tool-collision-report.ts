/**
 * Lists Code Mode tool-name collisions seen in production.
 *
 * When two installed apps project the same `namespace.tool` key, Code Mode
 * withholds BOTH and logs `tool_collision_quarantined` (apps/mcp
 * `codeModeCollisionOwners`); `discover.list_namespaces` also reports them as
 * `quarantinedTools`. This reads those events from Workers observability and
 * groups them by colliding key, so a collision is noticed before a user misses
 * a tool.
 *
 * Usage: CF_ACCOUNT_ID=… CF_OBSERVABILITY_TOKEN=… bun scripts/mcp/tool-collision-report.ts [--hours 24] [--json]
 * Exits 1 when any collision was seen in the window, 0 otherwise.
 */

export type CollisionEvent = {
	ownerKey?: unknown;
	owners?: unknown;
	timestamp?: number;
};

export type ToolCollision = {
	ownerKey: string;
	owners: string[];
	events: number;
	lastSeen: string | null;
};

export function groupToolCollisions(events: CollisionEvent[]): ToolCollision[] {
	const byKey = new Map<string, ToolCollision>();
	for (const event of events) {
		if (typeof event.ownerKey !== "string" || !event.ownerKey) continue;
		const entry = byKey.get(event.ownerKey) ?? {
			ownerKey: event.ownerKey,
			owners: [],
			events: 0,
			lastSeen: null,
		};
		entry.events += 1;
		if (Array.isArray(event.owners)) {
			for (const owner of event.owners) {
				if (typeof owner === "string" && !entry.owners.includes(owner)) {
					entry.owners.push(owner);
				}
			}
		}
		if (typeof event.timestamp === "number") {
			const seen = new Date(event.timestamp).toISOString();
			if (!entry.lastSeen || seen > entry.lastSeen) entry.lastSeen = seen;
		}
		byKey.set(event.ownerKey, entry);
	}
	return [...byKey.values()]
		.map((entry) => ({ ...entry, owners: entry.owners.sort() }))
		.sort(
			(a, b) => b.events - a.events || a.ownerKey.localeCompare(b.ownerKey),
		);
}

async function fetchCollisionEvents(hours: number): Promise<CollisionEvent[]> {
	const accountId = process.env.CF_ACCOUNT_ID;
	const token = process.env.CF_OBSERVABILITY_TOKEN;
	if (!accountId || !token) {
		throw new Error("CF_ACCOUNT_ID and CF_OBSERVABILITY_TOKEN are required");
	}
	const now = Date.now();
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				queryId: "tool-collision-report",
				timeframe: { from: now - hours * 3_600_000, to: now },
				view: "events",
				parameters: {
					datasets: ["cloudflare-workers"],
					filters: [
						{
							key: "event",
							operation: "eq",
							value: "tool_collision_quarantined",
							type: "string",
						},
					],
					limit: 2000,
				},
			}),
		},
	);
	const body = (await response.json()) as {
		success?: boolean;
		errors?: unknown;
		result?: {
			events?: {
				events?: Array<{ source?: CollisionEvent; timestamp?: number }>;
			};
		};
	};
	if (!response.ok || body.success === false) {
		throw new Error(
			`Observability query failed: ${response.status} ${JSON.stringify(body.errors)}`,
		);
	}
	return (body.result?.events?.events ?? []).map((event) => ({
		...(event.source ?? {}),
		timestamp: event.timestamp,
	}));
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const hoursIndex = args.indexOf("--hours");
	const hours = hoursIndex >= 0 ? Number(args[hoursIndex + 1]) : 24;
	if (!Number.isFinite(hours) || hours <= 0) {
		throw new Error("--hours must be a positive number");
	}
	const collisions = groupToolCollisions(await fetchCollisionEvents(hours));
	if (args.includes("--json")) {
		console.log(JSON.stringify({ hours, collisions }, null, 2));
	} else if (collisions.length === 0) {
		console.log(`No tool-name collisions in the last ${hours}h.`);
	} else {
		console.log(
			`${collisions.length} tool-name collision(s) in the last ${hours}h:`,
		);
		for (const c of collisions) {
			console.log(
				`- ${c.ownerKey}: ${c.owners.join(" + ")} (${c.events} events, last ${c.lastSeen ?? "?"})`,
			);
		}
	}
	process.exit(collisions.length > 0 ? 1 : 0);
}
