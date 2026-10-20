import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { computeSha256, generateReleaseArtifacts, resolveTargetCommit } from "./openapi.js";

describe("release artifacts & checksums generator", () => {
  it("computes accurate SHA-256 checksums", () => {
    const input = "test-payload-for-checksum";
    const expectedHash = "497bfa4761abdcb3079fd5da8ce1ee2f90c0e0f7d76f78e6a89d434d29111168";
    expect(computeSha256(input)).toBe(expectedHash);
  });

  it("resolves target commit from environment or existing commit", () => {
    process.env.RELEASE_COMMIT = "release-sha-999";
    try {
      expect(resolveTargetCommit(false)).toBe("release-sha-999");
    } finally {
      delete process.env.RELEASE_COMMIT;
    }

    expect(resolveTargetCommit(true, "existing-sha-123")).toBe("existing-sha-123");
  });

  it("validates that all published release artifacts match their checksums", async () => {
    const result = await generateReleaseArtifacts({ checkOnly: true });
    expect(result.success).toBe(true);

    const checksumsRaw = await readFile(resolve(process.cwd(), "docs/api/checksums.json"), "utf8");
    const checksumsManifest = JSON.parse(checksumsRaw);

    expect(checksumsManifest).toMatchObject({
      algorithm: "sha256",
      release: {
        version: "0.1.0",
        x402Version: 2,
        x402PackageVersion: "2.28.0"
      }
    });
    expect(checksumsManifest.release.commit).toBeDefined();
    expect(checksumsManifest.artifacts).toHaveLength(4);

    const sha256FileContent = await readFile(
      resolve(process.cwd(), "docs/api/checksums.sha256"),
      "utf8"
    );

    for (const item of checksumsManifest.artifacts) {
      const fileContent = await readFile(resolve(process.cwd(), item.path), "utf8");
      const actualHash = computeSha256(fileContent);
      expect(item.checksum).toBe(actualHash);
      expect(sha256FileContent).toContain(`${actualHash}  ${item.name}`);
    }
  });

  it("ensures openapi.json and conformance.json embed release compatibility metadata", async () => {
    const openApiRaw = await readFile(resolve(process.cwd(), "docs/api/openapi.json"), "utf8");
    const openApi = JSON.parse(openApiRaw);

    expect(openApi.info["x-release"]).toMatchObject({
      version: "0.1.0",
      x402Version: 2,
      x402PackageVersion: "2.28.0",
      protocol: "stellar-x402"
    });
    expect(openApi.info["x-release"].commit).toBeDefined();

    expect(openApi.info["x-compatibility"]).toMatchObject({
      protocol: "x402",
      x402Version: 2,
      x402PackageVersion: "2.28.0",
      supportedSchemes: ["exact", "upto"],
      networks: ["stellar:testnet", "stellar:pubnet"]
    });

    const conformanceRaw = await readFile(
      resolve(process.cwd(), "docs/api/conformance.json"),
      "utf8"
    );
    const conformance = JSON.parse(conformanceRaw);

    expect(conformance).toMatchObject({
      suite: "stellar-x402",
      version: "0.1.0",
      protocol: {
        name: "x402",
        version: 2,
        package: "@x402/core",
        packageVersion: "2.28.0"
      }
    });
    expect(conformance.commit).toBeDefined();
    expect(conformance.executionModes.local.verifiedOnChain).toBe(false);
    expect(conformance.executionModes.live.verifiedOnChain).toBe(true);
  });
});
