// Route registration for /workstation. Handlers live beside this file by
// group (lease.ts, files-exec.ts, process.ts) and are imported directly.
import { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { inspectRepositoryRoute } from "../workstation-inspection";
import {
	provisionWorkstation,
	wakeWorkstation,
	readWorkstationStatus,
	joinWorkstation,
	releaseWorkstation,
} from "./lease";
import { writeWorkstationFiles, execWorkstationCommand } from "./files-exec";
import {
	startWorkstationProcess,
	workstationProcessStatus,
	waitWorkstationProcess,
	cancelWorkstationProcess,
	startWorkstationDevServer,
} from "./process";

export const workstation = new Hono<AppEnv>();

workstation.post("/repository/inspect", inspectRepositoryRoute);
workstation.post("/provision", provisionWorkstation);
workstation.post("/wake", wakeWorkstation);
workstation.post("/status", readWorkstationStatus);
workstation.post("/files", writeWorkstationFiles);
workstation.post("/exec", execWorkstationCommand);
workstation.post("/join", joinWorkstation);
workstation.post("/release", releaseWorkstation);
workstation.post("/process/start", startWorkstationProcess);
workstation.post("/process/status", workstationProcessStatus);
workstation.post("/process/wait", waitWorkstationProcess);
workstation.post("/process/cancel", cancelWorkstationProcess);
workstation.post("/dev-server", startWorkstationDevServer);
