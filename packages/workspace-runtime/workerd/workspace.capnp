# A self-hosted workerd process that runs workspace objects with file-backed
# state. Every workspace's SQLite file lives under `stateDirectory`, and the
# sandbox loader is the `LOADER` binding. Build the Worker bundle first
# (`main.js` below is the bundled `apps/workspace-do` entry).
#
# Start it with:
#   workerd serve workspace.capnp
#
# Compiles with workerd 1.20261101.1 (`workerd compile workspace.capnp`); it
# has not been run as a service from this repository.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "workspace", worker = .workspaceWorker),
    (name = "workspace-state", disk = (path = "/var/lib/tedix/workspaces", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "workspace"),
  ],
);

const workspaceWorker :Workerd.Worker = (
  modules = [
    (name = "main.js", esModule = embed "main.js"),
  ],
  compatibilityDate = "2026-10-01",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [
    (className = "WorkspaceObject", uniqueKey = "tedix-workspace-v1", enableSql = true),
  ],
  # File-backed: each object's SQLite database is a file in the disk service.
  durableObjectStorage = (localDisk = "workspace-state"),
  bindings = [
    (name = "WORKSPACE", durableObjectNamespace = "WorkspaceObject"),
    # The sandbox. Every manifest the runtime loads sets globalOutbound to
    # null, so the loaded code reaches only the bindings it is given.
    (name = "LOADER", workerLoader = (id = "workspace-sandbox")),
  ],
);
