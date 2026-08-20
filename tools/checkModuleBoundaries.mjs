#!/usr/bin/env node
// Module boundary enforcer.
//
// Walks src/, parses every .ts file's import statements, and reports
// imports that violate ModuleRegistry's declared boundaries:
//
//   1. Cross-module import of a non-public-API file. Outside callers
//      may only import a module's `publicApi` (its index barrel).
//      Importing internal files (e.g. `../skills/SkillManager.js`
//      from `src/agents/Foo.ts`) is a violation unless skills.dependencies
//      includes "agents" or vice versa.
//
//   2. Cross-module import not declared in the dependency list.
//      Even via the barrel, only modules listed as dependencies may be
//      imported from.
//
// Imports inside the same module are always allowed.
// Imports from CORE_ALLOWLIST paths (utils, types, observability,
// config, lifecycle) are always allowed.
//
// The enforcer is deliberately implemented as a small JS script so it
// can run before/after the TypeScript build (no chicken-and-egg with
// dist/). It uses tsc-free import-statement parsing — a simple regex
// that handles the syntax patterns in this codebase.
//
// Exit codes:
//   0 — clean
//   1 — violations found
//   2 — script error (parse / IO)

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcRoot  = path.join(repoRoot, 'src');

// ── Re-state module rules in plain JS so this script doesn't depend on
//    TypeScript / dist artefacts. Keep in sync with src/modules/ModuleRegistry.ts.
const CORE_ALLOWLIST = ['src/types/', 'src/utils/', 'src/observability/', 'src/config/', 'src/lifecycle/'];

const MODULES = [
  { id: 'builder',     rootDir: 'src/builder',     publicApi: 'index.ts', dependencies: ['tenancy'] },
  { id: 'tenancy',     rootDir: 'src/tenancy',     publicApi: 'index.ts', dependencies: [] },
  { id: 'persistence', rootDir: 'src/persistence', publicApi: 'index.ts', dependencies: ['tenancy'] },
  { id: 'events',      rootDir: 'src/events',      publicApi: 'index.ts', dependencies: ['persistence', 'tenancy'] },
  { id: 'messaging',   rootDir: 'src/messaging',   publicApi: 'index.ts', dependencies: ['agents'] },
  { id: 'security',    rootDir: 'src/security',    publicApi: 'index.ts', dependencies: ['tenancy'] },
  { id: 'skills',      rootDir: 'src/skills',      publicApi: 'index.ts', dependencies: ['agents', 'security', 'persistence'] },
  { id: 'agents',      rootDir: 'src/agents',      publicApi: 'index.ts', dependencies: ['ai', 'persistence'] },
  { id: 'workflows',   rootDir: 'src/workflows',   publicApi: 'index.ts', dependencies: ['skills', 'security'] },
  { id: 'ai',          rootDir: 'src/ai',          publicApi: 'index.ts', dependencies: ['persistence'] },
  { id: 'modules',     rootDir: 'src/modules',     publicApi: 'index.ts', dependencies: ['tenancy'] },
];

// Modules whose enforcement we're rolling out incrementally. Strict
// modules are checked; non-strict ones are listed in MODULES so other
// strict modules can still declare a dependency on them, but their
// internal call sites aren't yet boundary-clean. Toggle a module to
// strict by adding its id here once its file imports are corrected.
const STRICT = new Set([
  'builder',
  'tenancy', 'modules',
  'ai', 'messaging',
  'events', 'workflows',
  'persistence',
  // security + skills have a pre-existing security ↔ skills cycle
  // (SandboxWorker imports skills; DelegationSkill imports security).
  // Their barrels are wired so external consumers stay clean, but
  // they don't enter STRICT until that cycle is broken via DI.
]);

// Files / dirs we don't scan: tests, type declarations, server
// integration shim (which legitimately wires every module together
// during the migration).
const EXCLUDE_FILE_RE = /\.(test|d)\.ts$/;
const EXCLUDE_PATH_RE = /[\\/](server\.ts|server\.ts\.backup)$/;

// Parse runtime imports — `import … from '…';` and bare `import '…';`.
// Excludes pure type-only imports (`import type { X } from '…'`) since
// those are erased at compile time and don't form runtime dependency
// edges. Mixed imports (`import { type X, runtime } from '…'`) still
// count because the module is loaded at runtime for the runtime
// bindings.
const IMPORT_RE = /(?<!type\s)import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const TYPE_ONLY_PREFIX_RE = /^\s*import\s+type\s/;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if (entry.endsWith('.ts') && !EXCLUDE_FILE_RE.test(entry)) out.push(full);
  }
  return out;
}

function relativePosix(p) {
  return p.split(path.sep).join('/');
}

/** Find which module owns a given absolute file path. */
function ownerModule(absPath) {
  const rel = relativePosix(path.relative(repoRoot, absPath));
  for (const m of MODULES) {
    if (rel.startsWith(m.rootDir + '/')) return m;
  }
  return null;
}

/** Resolve a relative import from within a file to an absolute path
 *  inside the repo. Returns null if the import is from node_modules
 *  (bare specifier) or otherwise outside src/. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  // Imports include the .js extension (NodeNext); strip it for the
  // file-on-disk lookup.
  const stripped = spec.replace(/\.js$/, '');
  const abs = path.resolve(path.dirname(fromFile), stripped);
  return abs;
}

function isCoreAllowed(targetRel) {
  return CORE_ALLOWLIST.some(prefix => targetRel.startsWith(prefix));
}

const violations = [];

for (const file of listFiles(srcRoot)) {
  if (EXCLUDE_PATH_RE.test(file)) continue;
  const owner = ownerModule(file);
  if (!owner || !STRICT.has(owner.id)) continue;

  const text = readFileSync(file, 'utf8');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    // Skip pure type-only imports — `import type { … } from …` is
    // erased before runtime, so it doesn't create a real dependency
    // edge that the boundary enforcer needs to gate. Look at the
    // beginning of the matched line for the marker.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineHead  = text.slice(lineStart, m.index + 7); // "import "
    if (TYPE_ONLY_PREFIX_RE.test(text.slice(lineStart, lineStart + 16))) continue;
    void lineHead;

    const target = resolveImport(file, m[1]);
    if (!target) continue;

    const rel = relativePosix(path.relative(repoRoot, target));

    // Same-module imports + core allowlist always pass.
    if (rel.startsWith(owner.rootDir + '/')) continue;
    if (isCoreAllowed(rel + '/') || isCoreAllowed(rel)) continue;

    const targetOwner = MODULES.find(mod => rel.startsWith(mod.rootDir + '/'));
    if (!targetOwner) {
      // Unknown — module list incomplete. Don't fail; just note.
      continue;
    }

    // Dependency declared?
    if (!owner.dependencies.includes(targetOwner.id)) {
      violations.push({
        file: relativePosix(path.relative(repoRoot, file)),
        importing: m[1],
        from: owner.id,
        to: targetOwner.id,
        reason: `module "${owner.id}" does not declare dependency on "${targetOwner.id}"`,
      });
      continue;
    }

    // Public-API rule: outside-module imports must hit the barrel.
    if (targetOwner.publicApi) {
      // The import target should resolve to <rootDir>/<publicApi>.
      // Spec ends with .js, so we compare against publicApi sans .ts.
      const expectedRel = `${targetOwner.rootDir}/${targetOwner.publicApi.replace(/\.ts$/, '')}`;
      if (rel !== expectedRel) {
        violations.push({
          file: relativePosix(path.relative(repoRoot, file)),
          importing: m[1],
          from: owner.id,
          to: targetOwner.id,
          reason: `import bypasses public API (expected "${expectedRel}.js")`,
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`module boundaries clean (${Array.from(STRICT).join(', ')} enforced)`);
  process.exit(0);
}

console.log(`Found ${violations.length} module-boundary violation(s):\n`);
for (const v of violations) {
  console.log(`  ${v.file}`);
  console.log(`    imports "${v.importing}"`);
  console.log(`    ${v.from} → ${v.to}: ${v.reason}\n`);
}
process.exit(1);
