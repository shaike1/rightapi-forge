#!/usr/bin/env node
/**
 * esbuild-based transpile script — replaces tsc for production builds.
 * Transpiles each .ts file individually (no bundling, no type-checking).
 * Preserves directory structure: src/ → dist/
 *
 * Also copies static asset directories (public/) into dist/ so runtime
 * code can read them with the same relative path layout it has at dev
 * time. Currently used by the factory-dashboard's Kanban UI.
 */
import { build } from 'esbuild';
import { readdir, mkdir, copyFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'src');
const DIST = join(__dirname, 'dist');

await rm(DIST, { recursive: true, force: true });

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...await walk(full));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Recursively copy every file under `srcDir` into the parallel path under `dstDir`. */
async function copyStaticTree(srcDir, dstDir) {
  let copied = 0;
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return 0; // directory doesn't exist — nothing to copy
  }
  await mkdir(dstDir, { recursive: true });
  for (const e of entries) {
    const srcPath = join(srcDir, e.name);
    const dstPath = join(dstDir, e.name);
    if (e.isDirectory()) {
      copied += await copyStaticTree(srcPath, dstPath);
    } else if (e.isFile()) {
      await copyFile(srcPath, dstPath);
      copied++;
    }
  }
  return copied;
}

const files = await walk(SRC);
console.log(`Building ${files.length} TypeScript files with esbuild…`);

await build({
  entryPoints: files,
  outbase: SRC,
  outdir: DIST,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: false,
  sourcemap: false,
  logLevel: 'warning',
});

console.log(`✓ Built ${files.length} files → dist/`);

// Static asset directories that need to land in dist/.
const staticDirs = [
  ['factory-dashboard/public', 'factory-dashboard/public'],
  // Bundled runbook library (.workflow.json files); RunbookLibrary
  // resolves its dir relative to its own compiled location, so the
  // JSON has to ship alongside dist/runbooks/RunbookLibrary.js.
  ['runbooks/library',          'runbooks/library'],
];
let totalCopied = 0;
for (const [srcRel, dstRel] of staticDirs) {
  const c = await copyStaticTree(join(SRC, srcRel), join(DIST, dstRel));
  if (c > 0) console.log(`  copied ${c} static file(s) from src/${srcRel} → dist/${dstRel}`);
  totalCopied += c;
}
if (totalCopied === 0) console.log('  (no static assets to copy)');
