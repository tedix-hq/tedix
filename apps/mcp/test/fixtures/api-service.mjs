/** Separate local Worker standing in for an unavailable apps/api service. */
export default {
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/fixture-health") {
			return Response.json({ fixture: "api-service" });
		}
		return Response.json(
			{ code: "SERVICE_UNAVAILABLE", message: "Fixture API unavailable" },
			{ status: 503 },
		);
	},
};
