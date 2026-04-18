import { execFile } from "node:child_process";

export function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts?.timeout ?? 5 * 60_000,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        if (stdout) {
          resolve({ stdout: stdout.toString(), stderr: stderr?.toString() ?? "" });
        } else {
          reject(err);
        }
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr?.toString() ?? "" });
      }
    });
    // Close stdin so CLI backends don't wait for input
    child.stdin?.end();
  });
}
