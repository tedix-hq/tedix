import { describeGovernanceConformance } from "./conformance";
import { createInMemoryAdapters } from "./in-memory";
describeGovernanceConformance(
	"In-memory governance conformance",
	createInMemoryAdapters,
);
