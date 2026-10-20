import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { buildOpenApiSpec, renderOpenApiMarkdown } from "../apps/api/src/openapi.js";
import {
  buildConformanceSpec,
  renderConformanceMarkdown
} from "../apps/api/src/services/conformance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function computeSha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function resolveTargetCommit(checkOnly: boolean, existingCommit?: string): string {
  const commitArgIndex = process.argv.indexOf("--commit");
  if (commitArgIndex !== -1 && process.argv[commitArgIndex + 1]) {
    return process.argv[commitArgIndex + 1];
  }

  if (checkOnly && existingCommit && existingCommit !== "unspecified") {
    return existingCommit;
  }

  const envCommit =
    process.env.RELEASE_COMMIT ??
    process.env.GIT_COMMIT ??
    process.env.GITHUB_SHA ??
    process.env.RENDER_GIT_COMMIT;
  if (envCommit) {
    return envCommit;
  }

  try {
    const gitSha = execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (gitSha) return gitSha;
  } catch {
    // Fallback if git is not available
  }

  return existingCommit ?? "unspecified";
}

export async function generateReleaseArtifacts(options: { checkOnly?: boolean } = {}) {
  const checkOnly = options.checkOnly ?? process.argv.includes("--check");

  const packageJsonPath = resolve(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version: string = packageJson.version ?? "0.1.0";
  const x402PackageVersion: string =
    packageJson.dependencies?.["@x402/core"]?.replace(/^[\^~]/, "") ?? "2.28.0";
  const x402StellarPackageVersion: string =
    packageJson.dependencies?.["@x402/stellar"]?.replace(/^[\^~]/, "") ?? "2.28.0";

  const checksumsPath = resolve(root, "docs/api/checksums.json");
  const existingChecksumsRaw = await readFile(checksumsPath, "utf8").catch(() => undefined);
  let existingCommit: string | undefined;
  let existingGeneratedAt: string | undefined;

  if (existingChecksumsRaw) {
    try {
      const parsed = JSON.parse(existingChecksumsRaw);
      existingCommit = parsed.release?.commit;
      existingGeneratedAt = parsed.generatedAt;
    } catch {
      // Ignore parse failure on existing checksums
    }
  }

  if (!existingCommit) {
    const openapiJsonPath = resolve(root, "docs/api/openapi.json");
    const existingOpenApiRaw = await readFile(openapiJsonPath, "utf8").catch(() => undefined);
    if (existingOpenApiRaw) {
      try {
        const parsed = JSON.parse(existingOpenApiRaw);
        existingCommit = parsed.info?.["x-release"]?.commit;
      } catch {
        // Ignore parse failure
      }
    }
  }

  const commit = resolveTargetCommit(checkOnly, existingCommit);

  const openApiSpec = buildOpenApiSpec({ commit, version, x402PackageVersion });
  const openApiMd = renderOpenApiMarkdown(openApiSpec);
  const conformanceSpec = buildConformanceSpec({
    commit,
    version,
    x402PackageVersion,
    x402StellarPackageVersion
  });
  const conformanceMd = renderConformanceMarkdown(conformanceSpec);

  const rawArtifacts = [
    {
      name: "openapi.json",
      path: "docs/api/openapi.json",
      parser: "json" as const,
      source: JSON.stringify(openApiSpec)
    },
    {
      name: "openapi.md",
      path: "docs/api/openapi.md",
      parser: "markdown" as const,
      source: openApiMd
    },
    {
      name: "conformance.json",
      path: "docs/api/conformance.json",
      parser: "json" as const,
      source: JSON.stringify(conformanceSpec)
    },
    {
      name: "conformance.md",
      path: "docs/api/conformance.md",
      parser: "markdown" as const,
      source: conformanceMd
    }
  ];

  const formattedArtifacts: Array<{
    name: string;
    path: string;
    content: string;
    checksum: string;
    bytes: number;
  }> = [];

  for (const artifact of rawArtifacts) {
    const absolutePath = resolve(root, artifact.path);
    const prettierOptions = (await resolveConfig(absolutePath)) ?? {};
    const content = await format(artifact.source, {
      ...prettierOptions,
      parser: artifact.parser
    });
    const checksum = computeSha256(content);
    formattedArtifacts.push({
      name: artifact.name,
      path: artifact.path,
      content,
      checksum,
      bytes: Buffer.byteLength(content, "utf8")
    });
  }

  const generatedAt =
    checkOnly && existingGeneratedAt ? existingGeneratedAt : new Date().toISOString();

  const checksumsManifest = {
    release: {
      version,
      commit,
      x402Version: 2,
      x402PackageVersion
    },
    algorithm: "sha256",
    generatedAt,
    artifacts: formattedArtifacts.map((a) => ({
      name: a.name,
      path: a.path,
      checksum: a.checksum,
      bytes: a.bytes
    }))
  };

  const checksumsJsonPrettier = (await resolveConfig(checksumsPath)) ?? {};
  const formattedChecksumsJson = await format(JSON.stringify(checksumsManifest), {
    ...checksumsJsonPrettier,
    parser: "json"
  });

  const checksumsSha256Content =
    formattedArtifacts.map((a) => `${a.checksum}  ${a.name}`).join("\n") + "\n";

  const allArtifacts = [
    ...formattedArtifacts.map((a) => ({ path: a.path, content: a.content })),
    { path: "docs/api/checksums.json", content: formattedChecksumsJson },
    { path: "docs/api/checksums.sha256", content: checksumsSha256Content }
  ];

  if (checkOnly) {
    let hasDrift = false;
    for (const artifact of allArtifacts) {
      const absolutePath = resolve(root, artifact.path);
      const current = await readFile(absolutePath, "utf8").catch(() => "");
      if (current !== artifact.content) {
        console.error(`${artifact.path} is out of sync. Run pnpm openapi:generate.`);
        hasDrift = true;
      }
    }

    if (hasDrift) {
      process.exitCode = 1;
      return { success: false, artifacts: allArtifacts };
    }

    return { success: true, artifacts: allArtifacts };
  }

  for (const artifact of allArtifacts) {
    const absolutePath = resolve(root, artifact.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, artifact.content, "utf8");
    console.log(`wrote ${artifact.path}`);
  }

  return { success: true, artifacts: allArtifacts };
}

// Auto-run when executed directly via tsx / node
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await generateReleaseArtifacts();
}
