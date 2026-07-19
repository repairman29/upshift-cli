import { spawn } from "child_process";

export async function openUrl(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to open browser (exit ${code})`));
      }
    });
  });
}
