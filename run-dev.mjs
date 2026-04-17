import { spawn } from "node:child_process";

process.env.PORT ||= "18312";
process.env.BASE_PATH ||= "/";

const child = spawn(
  "corepack pnpm --filter @workspace/audio-tracker run dev",
  {
  stdio: "inherit",
    shell: true,
    env: process.env,
  },
);

child.on("error", (error) => {
  console.error("Failed to start dev server:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
