import type {
	ExecutionCapability,
	ExecutionRequirement,
	ExecutionSurface,
} from "../schemas/execution-evidence";

export const MANAGED_JOB_EXECUTION_CAPABILITIES = new Set<ExecutionCapability>([
	"dependency_install",
	"typecheck",
	"tests",
	"lint",
	"build",
	"deploy",
	"notebook",
	"data",
	"live_verify",
]);

export const INTERACTIVE_WORKSTATION_EXECUTION_CAPABILITIES =
	new Set<ExecutionCapability>([
		"browser_session",
		"dev_server",
		"git_network",
		"process",
	]);

const SURFACE_RANK: Record<ExecutionSurface, number> = {
	native: 0,
	managed_job: 1,
	workstation: 2,
};

function minimumSurface(capabilities: ExecutionCapability[]): ExecutionSurface {
	if (
		capabilities.some((capability) =>
			INTERACTIVE_WORKSTATION_EXECUTION_CAPABILITIES.has(capability),
		)
	) {
		return "workstation";
	}
	if (
		capabilities.some((capability) =>
			MANAGED_JOB_EXECUTION_CAPABILITIES.has(capability),
		)
	) {
		return "managed_job";
	}
	return "native";
}

/** Resolve an explicit capability request through Tedix's canonical lattice. */
export function resolveExecutionRequirement(input: {
	requiredCapabilities: ExecutionCapability[];
	preferredSurface?: ExecutionSurface;
	prohibitedSurfaces?: ExecutionSurface[];
}): ExecutionRequirement {
	const prohibitedSurfaces = [...new Set(input.prohibitedSurfaces ?? [])];
	const minimum = minimumSurface(input.requiredCapabilities);
	const preferred = input.preferredSurface;
	const surface =
		preferred && SURFACE_RANK[preferred] >= SURFACE_RANK[minimum]
			? preferred
			: minimum;
	const satisfiable = !prohibitedSurfaces.includes(surface);
	const fallbackSurface =
		surface === "native" && !prohibitedSurfaces.includes("workstation")
			? "workstation"
			: surface === "managed_job" && !prohibitedSurfaces.includes("workstation")
				? "workstation"
				: null;

	let reason: string;
	if (!satisfiable) {
		reason = `the ${surface} surface required by the capability bundle is explicitly prohibited`;
	} else if (surface === "workstation") {
		reason =
			"the typed capability set requires an interactive OS, process, browser, dev-server, or Git-network session";
	} else if (surface === "managed_job") {
		reason =
			"the typed capability set requires a bounded durable job with a terminal receipt";
	} else {
		reason = "the typed capability set fits Agent-runtime tools";
	}
	if (
		preferred &&
		SURFACE_RANK[preferred] < SURFACE_RANK[minimum] &&
		satisfiable
	) {
		reason += `; preferred surface ${preferred} cannot satisfy the minimum ${minimum} requirement`;
	}

	return {
		surface,
		requiredCapabilities: [...new Set(input.requiredCapabilities)],
		fallbackSurface,
		prohibitedSurfaces,
		satisfiable,
		reason,
	};
}
