/*
 * Runs the Python reference loader against the shared vectors, isolated (-I). Looks for
 * python3, then python. Without a Python 3.10+ interpreter the step fails, so the gate never
 * reports green without running a vector; OPR_SKIP_PYTHON=1 skips it explicitly and says so.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./collect.ts";

const CANDIDATES = ["python3", "python"];

function findPython(): string | undefined {
  return CANDIDATES.find((name) => {
    const probe = spawnSync(name, ["-I", "-c", "import sys; sys.exit(sys.version_info < (3, 10))"]);
    return probe.error === undefined && probe.status === 0;
  });
}

if (process.env["OPR_SKIP_PYTHON"] === "1") {
  process.stderr.write("python-vectors: SKIPPED because OPR_SKIP_PYTHON=1.\n");
  process.exit(0);
}
const python = findPython();
if (python === undefined) {
  process.stderr.write(
    `python-vectors: no Python 3.10+ found (tried ${CANDIDATES.join(", ")}); ` +
      "install one or set OPR_SKIP_PYTHON=1 to skip explicitly.\n",
  );
  process.exit(1);
}
// -I: ignore the environment and user site; -B: leave no bytecode in the repository.
const script = join(ROOT, "python", "run_vectors.py");
const run = spawnSync(python, ["-I", "-B", script, join(ROOT, "dist")], { stdio: "inherit" });
process.exit(run.status ?? 1);
