// `vitest.config.ts` beside this file is what vitest reads, so this config carries the
// cached task alone and must not re-declare test settings.
import { vitestTask } from "../../scripts/vite/task-config";

export default { run: { tasks: { unit: vitestTask("vp test run") } } };
