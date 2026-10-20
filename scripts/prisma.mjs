import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const schemaPath = "prisma/schema.prisma";
const command = process.argv[2] ?? "validate";

if (!existsSync(schemaPath)) {
  console.log(`Skipping prisma ${command}; ${schemaPath} does not exist yet.`);
  process.exit(0);
}

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/lumenbazaar";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const result = spawnSync(pnpmCommand, ["exec", "prisma", command, "--schema", schemaPath], {
  env: process.env,
  shell: true,
  stdio: "inherit"
});

if (result.error !== undefined) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
