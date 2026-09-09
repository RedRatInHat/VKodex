import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Do not start the next metadata operation while this process still owns a writer. */
export function closeAppServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    child.stdin.end(); return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill); clearTimeout(deadline); child.off("close", closed); child.off("exit", closed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish();
    const kill = setTimeout(() => child.kill(), 1_000);
    const deadline = setTimeout(() => finish(new Error("App Server did not release its process")), 5_000);
    // On Windows, stdio 'close' can lag process 'exit' by several seconds for a
    // large fork. The OS has released the writer at exit; pipe draining is not
    // a live writer and must not turn an acknowledged fork into an unknown one.
    child.once("exit", closed); child.once("close", closed);
    child.stdin.end();
  });
}
