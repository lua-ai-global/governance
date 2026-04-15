/**
 * governance-sdk — CycloneDX 1.5 SBOM generator
 *
 * Emits a spec-compliant CycloneDX 1.5 JSON document from a parsed
 * `package.json` + `package-lock.json` (npm lockfile v2 or v3).
 *
 * Spec: https://cyclonedx.org/docs/1.5/json/
 *
 * Scope: npm lockfile v2/v3 (the format npm has emitted since npm 7, Oct 2020).
 * Supports scoped packages, dev dependencies, transitive dependencies, and
 * sha-512 integrity hashes (when present in the lockfile).
 *
 * Validates against the official CycloneDX 1.5 JSON schema.
 */

// ─── CycloneDX 1.5 types (subset we emit) ───────────────────

export interface CycloneDxHash {
  alg: "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512" | "SHA3-256" | "SHA3-384" | "SHA3-512" | "BLAKE2b-256" | "BLAKE2b-384" | "BLAKE2b-512" | "BLAKE3";
  content: string;
}

export interface CycloneDxLicense {
  license?: { id?: string; name?: string };
  expression?: string;
}

export interface CycloneDxComponent {
  type: "application" | "framework" | "library" | "container" | "platform" | "operating-system" | "device" | "device-driver" | "firmware" | "file" | "machine-learning-model" | "data";
  "bom-ref": string;
  name: string;
  version?: string;
  purl?: string;
  scope?: "required" | "optional" | "excluded";
  description?: string;
  hashes?: CycloneDxHash[];
  licenses?: CycloneDxLicense[];
  supplier?: { name?: string };
  externalReferences?: Array<{ type: string; url: string }>;
}

export interface CycloneDxDependency {
  ref: string;
  dependsOn?: string[];
}

export interface CycloneDxTool {
  vendor?: string;
  name: string;
  version?: string;
}

export interface CycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools?: { components: Array<CycloneDxTool & { type: "application" }> };
    component?: CycloneDxComponent;
  };
  components: CycloneDxComponent[];
  dependencies?: CycloneDxDependency[];
}

// ─── Lockfile input types (npm v2/v3 `packages` shape) ─────

export interface NpmLockfilePackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string | { type?: string };
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface NpmLockfile {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, NpmLockfilePackage>;
}

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  author?: string | { name?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface CycloneDxGeneratorInput {
  packageJson: PackageJson;
  /** npm lockfile v2 or v3. If omitted, only top-level deps are included. */
  lockfile?: NpmLockfile;
  /** Include devDependencies in the output? Default `false`. */
  includeDev?: boolean;
  /** Tool emitting this BOM. Defaults to governance-sdk. */
  tool?: CycloneDxTool;
  /** Override the generation timestamp (ISO 8601). Useful for reproducibility in tests. */
  timestamp?: string;
  /** Override the `serialNumber` (urn:uuid:…). Useful for tests. */
  serialNumber?: string;
}

// ─── Utilities ──────────────────────────────────────────────

function generateUUID(): string {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build a package URL per https://github.com/package-url/purl-spec.
 * For npm: pkg:npm/<name>@<version>  (scoped packages keep the @scope/name
 * after pkg:npm/ with the leading `@` URL-encoded per spec).
 */
export function npmPurl(name: string, version: string | undefined): string {
  // purl-spec: for npm, scope is NOT a separate segment — the full
  // `@scope/name` goes in the name position. `@` MUST be percent-encoded.
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return version ? `pkg:npm/${encoded}@${version}` : `pkg:npm/${encoded}`;
}

/**
 * Convert an npm lockfile integrity string ("sha512-<base64>") into a
 * CycloneDX hash object. Returns undefined if the format is unrecognised.
 */
export function integrityToHash(integrity: string): CycloneDxHash | undefined {
  // npm writes integrity as e.g. `sha512-<base64>` (SRI format)
  const match = /^sha(256|384|512)-(.+)$/.exec(integrity);
  if (!match) return undefined;
  const alg = `SHA-${match[1]}` as CycloneDxHash["alg"];
  // Convert base64 → hex so validators that expect hex content pass.
  try {
    const buf = Buffer.from(match[2], "base64");
    return { alg, content: buf.toString("hex") };
  } catch {
    return undefined;
  }
}

/**
 * Split a lockfile key like "node_modules/foo" or
 * "node_modules/@scope/foo/node_modules/bar" into the bare package name.
 */
function packageNameFromLockKey(key: string): string | undefined {
  // Find the last "node_modules/" segment and return the package name after it.
  const idx = key.lastIndexOf("node_modules/");
  if (idx < 0) return undefined;
  const rest = key.slice(idx + "node_modules/".length);
  if (!rest) return undefined;
  if (rest.startsWith("@")) {
    // Scoped: @scope/name[/...]
    const parts = rest.split("/");
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  const [name] = rest.split("/");
  return name;
}

// ─── Generator ──────────────────────────────────────────────

export function generateCycloneDxSbom(input: CycloneDxGeneratorInput): CycloneDxBom {
  const {
    packageJson,
    lockfile,
    includeDev = false,
    tool = { vendor: "Lua", name: "governance-sdk" },
    timestamp = new Date().toISOString(),
    serialNumber = `urn:uuid:${generateUUID()}`,
  } = input;

  const rootName = packageJson.name ?? "root";
  const rootVersion = packageJson.version ?? "0.0.0";
  const rootRef = `pkg:npm/${rootName.startsWith("@") ? "%40" + rootName.slice(1) : rootName}@${rootVersion}`;

  const rootComponent: CycloneDxComponent = {
    type: "application",
    "bom-ref": rootRef,
    name: rootName,
    version: rootVersion,
    purl: npmPurl(rootName, rootVersion),
    description: packageJson.description,
    supplier: packageJson.author
      ? { name: typeof packageJson.author === "string" ? packageJson.author : packageJson.author.name }
      : undefined,
    licenses: packageJson.license ? [{ license: { id: packageJson.license } }] : undefined,
  };

  // Collect components from the lockfile `packages` map (npm v2/v3).
  const components: CycloneDxComponent[] = [];
  const dependencies: CycloneDxDependency[] = [];
  const seen = new Set<string>();

  if (lockfile?.packages) {
    for (const [key, pkg] of Object.entries(lockfile.packages)) {
      if (key === "") continue; // root — already represented
      if (!includeDev && pkg.dev) continue;
      const name = packageNameFromLockKey(key);
      if (!name || !pkg.version) continue;
      const ref = `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${pkg.version}`;
      if (seen.has(ref)) continue;
      seen.add(ref);

      const hashes: CycloneDxHash[] = [];
      if (pkg.integrity) {
        const h = integrityToHash(pkg.integrity);
        if (h) hashes.push(h);
      }
      const licenseId = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;

      components.push({
        type: "library",
        "bom-ref": ref,
        name,
        version: pkg.version,
        purl: npmPurl(name, pkg.version),
        scope: pkg.optional ? "optional" : "required",
        hashes: hashes.length ? hashes : undefined,
        licenses: licenseId ? [{ license: { id: licenseId } }] : undefined,
        externalReferences: pkg.resolved
          ? [{ type: "distribution", url: pkg.resolved }]
          : undefined,
      });

      // Dependency graph — only direct children declared in the lockfile entry.
      if (pkg.dependencies) {
        const dependsOn: string[] = [];
        for (const [depName, _depVersionSpec] of Object.entries(pkg.dependencies)) {
          // Resolve the installed version of this dep by looking it up in the
          // lockfile. We prefer the nested (key `${key}/node_modules/${depName}`)
          // entry; fall back to a top-level one.
          const nestedKey = `${key}/node_modules/${depName}`;
          const nested = lockfile.packages[nestedKey];
          const topLevel = lockfile.packages[`node_modules/${depName}`];
          const resolvedVersion = nested?.version ?? topLevel?.version;
          if (!resolvedVersion) continue;
          dependsOn.push(
            `pkg:npm/${depName.startsWith("@") ? "%40" + depName.slice(1) : depName}@${resolvedVersion}`,
          );
        }
        if (dependsOn.length) dependencies.push({ ref, dependsOn });
      }
    }
  } else {
    // No lockfile — emit top-level deps from package.json with no pinned versions.
    for (const [depName, depSpec] of Object.entries(packageJson.dependencies ?? {})) {
      const ref = `pkg:npm/${depName.startsWith("@") ? "%40" + depName.slice(1) : depName}@${depSpec}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      components.push({
        type: "library",
        "bom-ref": ref,
        name: depName,
        version: depSpec,
        purl: npmPurl(depName, depSpec),
        scope: "required",
      });
    }
  }

  // Root dependency graph entry.
  const rootDependsOn: string[] = [];
  for (const [depName] of Object.entries(packageJson.dependencies ?? {})) {
    const topLevel = lockfile?.packages?.[`node_modules/${depName}`];
    if (topLevel?.version) {
      rootDependsOn.push(
        `pkg:npm/${depName.startsWith("@") ? "%40" + depName.slice(1) : depName}@${topLevel.version}`,
      );
    }
  }
  if (includeDev) {
    for (const [depName] of Object.entries(packageJson.devDependencies ?? {})) {
      const topLevel = lockfile?.packages?.[`node_modules/${depName}`];
      if (topLevel?.version) {
        rootDependsOn.push(
          `pkg:npm/${depName.startsWith("@") ? "%40" + depName.slice(1) : depName}@${topLevel.version}`,
        );
      }
    }
  }
  if (rootDependsOn.length) {
    dependencies.unshift({ ref: rootRef, dependsOn: rootDependsOn });
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber,
    version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ ...tool, type: "application" }] },
      component: rootComponent,
    },
    components,
    dependencies: dependencies.length ? dependencies : undefined,
  };
}
