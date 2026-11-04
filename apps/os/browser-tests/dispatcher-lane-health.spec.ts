import { runLaneStates } from "./dispatcher-lane-health-checks";

// Fixture lanes, friendly reasons, duties, stale and empty/error reports.
// Task activity rows run as dispatcher-lane-activity-*.spec.ts.
await runLaneStates();
