import { expect, it } from "vite-plus/test";
import {
	cmsRestoreFenceResponse,
	cmsTemporarilyUnavailableResponse,
} from "./tenant-restore-fence";

it("tells a closed restore fence apart from a passing failure", async () => {
	const restore = cmsRestoreFenceResponse();
	const passing = cmsTemporarilyUnavailableResponse();
	expect([restore.status, passing.status]).toEqual([503, 503]);
	expect(restore.headers.get("X-Tedix-Cms-Unavailable")).toBe("restore");
	expect(passing.headers.get("X-Tedix-Cms-Unavailable")).toBe("transient");
	expect(await restore.text()).toContain("during restore");
	expect(await passing.text()).not.toContain("restore");
	expect(passing.headers.get("Retry-After")).toBe("5");
});
