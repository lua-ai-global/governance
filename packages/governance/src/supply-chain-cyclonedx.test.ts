import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateCycloneDxSbom,
  integrityToHash,
  npmPurl,
  type PackageJson,
  type NpmLockfile,
} from "./supply-chain-cyclonedx";

describe("CycloneDX 1.5 SBOM", () => {
  describe("npmPurl", () => {
    it("builds purls for plain packages", () => {
      assert.equal(npmPurl("lodash", "4.17.21"), "pkg:npm/lodash@4.17.21");
    });

    it("percent-encodes scoped packages per purl-spec", () => {
      assert.equal(
        npmPurl("@anthropic-ai/sdk", "0.20.1"),
        "pkg:npm/%40anthropic-ai/sdk@0.20.1",
      );
    });

    it("omits version when not provided", () => {
      assert.equal(npmPurl("lodash", undefined), "pkg:npm/lodash");
    });
  });

  describe("integrityToHash", () => {
    it("converts sha512 SRI to CycloneDX hash (hex)", () => {
      // base64 of "hello" = "aGVsbG8="; hex = 68656c6c6f
      const h = integrityToHash("sha512-aGVsbG8=");
      assert.ok(h);
      assert.equal(h!.alg, "SHA-512");
      assert.equal(h!.content, "68656c6c6f");
    });

    it("supports sha256 and sha384", () => {
      assert.equal(integrityToHash("sha256-aGVsbG8=")?.alg, "SHA-256");
      assert.equal(integrityToHash("sha384-aGVsbG8=")?.alg, "SHA-384");
    });

    it("returns undefined for unrecognised formats", () => {
      assert.equal(integrityToHash("md5-whatever"), undefined);
      assert.equal(integrityToHash("not-an-integrity-string"), undefined);
    });
  });

  describe("generateCycloneDxSbom", () => {
    const fixedTimestamp = "2026-04-15T10:00:00.000Z";
    const fixedSerial = "urn:uuid:12345678-1234-4123-8123-123456789abc";

    const basePkg: PackageJson = {
      name: "my-agent",
      version: "1.2.3",
      description: "A test agent",
      license: "MIT",
      author: "Lua",
      dependencies: { "@anthropic-ai/sdk": "^0.20.1", lodash: "^4.17.21" },
      devDependencies: { typescript: "^5.7.0" },
    };

    const baseLockfile: NpmLockfile = {
      name: "my-agent",
      version: "1.2.3",
      lockfileVersion: 3,
      packages: {
        "": { version: "1.2.3" },
        "node_modules/@anthropic-ai/sdk": {
          version: "0.20.1",
          resolved: "https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-0.20.1.tgz",
          integrity: "sha512-aGVsbG8=",
          license: "MIT",
          dependencies: { lodash: "^4.17.21" },
        },
        "node_modules/lodash": {
          version: "4.17.21",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
          integrity: "sha512-aGVsbG8=",
          license: "MIT",
        },
        "node_modules/typescript": {
          version: "5.7.2",
          resolved: "https://registry.npmjs.org/typescript/-/typescript-5.7.2.tgz",
          integrity: "sha512-aGVsbG8=",
          license: "Apache-2.0",
          dev: true,
        },
      },
    };

    it("emits spec-compliant top-level shape", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });

      assert.equal(sbom.bomFormat, "CycloneDX");
      assert.equal(sbom.specVersion, "1.5");
      assert.equal(sbom.serialNumber, fixedSerial);
      assert.equal(sbom.version, 1);
      assert.equal(sbom.metadata.timestamp, fixedTimestamp);
      assert.equal(sbom.metadata.tools?.components[0].name, "governance-sdk");
      assert.equal(sbom.metadata.component?.name, "my-agent");
      assert.equal(sbom.metadata.component?.version, "1.2.3");
    });

    it("includes required components with purl, hashes, and licenses", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });

      const anthropic = sbom.components.find((c) => c.name === "@anthropic-ai/sdk");
      assert.ok(anthropic, "@anthropic-ai/sdk missing from components");
      assert.equal(anthropic!.type, "library");
      assert.equal(anthropic!.purl, "pkg:npm/%40anthropic-ai/sdk@0.20.1");
      assert.equal(anthropic!.hashes?.[0].alg, "SHA-512");
      assert.equal(anthropic!.licenses?.[0].license?.id, "MIT");
      assert.equal(anthropic!.scope, "required");
    });

    it("excludes devDependencies by default", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });
      const ts = sbom.components.find((c) => c.name === "typescript");
      assert.equal(ts, undefined);
    });

    it("includes devDependencies when includeDev is true", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        includeDev: true,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });
      const ts = sbom.components.find((c) => c.name === "typescript");
      assert.ok(ts, "typescript should be included with includeDev: true");
    });

    it("emits a dependency graph linking root → direct → transitive", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });

      assert.ok(sbom.dependencies, "dependencies graph missing");
      // Root entry lists @anthropic-ai/sdk and lodash as direct deps.
      const rootEntry = sbom.dependencies!.find((d) => d.ref.includes("my-agent"));
      assert.ok(rootEntry);
      assert.ok(rootEntry!.dependsOn?.includes("pkg:npm/%40anthropic-ai/sdk@0.20.1"));
      assert.ok(rootEntry!.dependsOn?.includes("pkg:npm/lodash@4.17.21"));
      // @anthropic-ai/sdk → lodash.
      const anthropicEntry = sbom.dependencies!.find((d) =>
        d.ref === "pkg:npm/%40anthropic-ai/sdk@0.20.1",
      );
      assert.ok(anthropicEntry);
      assert.deepEqual(anthropicEntry!.dependsOn, ["pkg:npm/lodash@4.17.21"]);
    });

    it("handles missing lockfile gracefully (top-level only, no pins)", () => {
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });
      assert.equal(sbom.bomFormat, "CycloneDX");
      // Without lockfile, we still emit top-level deps with their spec as version.
      const lodash = sbom.components.find((c) => c.name === "lodash");
      assert.ok(lodash);
      assert.equal(lodash!.version, "^4.17.21");
    });

    it("passes CycloneDX 1.5 required-field validation", () => {
      // Spot-check of the fields CycloneDX 1.5 JSON schema marks `required`:
      //   bomFormat, specVersion, version, metadata (with timestamp), components[].type, components[].name
      const sbom = generateCycloneDxSbom({
        packageJson: basePkg,
        lockfile: baseLockfile,
        timestamp: fixedTimestamp,
        serialNumber: fixedSerial,
      });
      assert.equal(sbom.bomFormat, "CycloneDX");
      assert.equal(sbom.specVersion, "1.5");
      assert.equal(typeof sbom.version, "number");
      assert.ok(sbom.metadata);
      assert.ok(sbom.metadata.timestamp);
      for (const c of sbom.components) {
        assert.ok(c.type);
        assert.ok(c.name);
        assert.ok(c["bom-ref"]);
      }
    });
  });
});
