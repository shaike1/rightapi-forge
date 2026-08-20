import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const checkMode = process.argv.includes('--check');

// Some old npm packages omit license metadata from the published tarball even
// though their upstream repository declares a license. Keep exceptions small,
// explicit, and source-linked so they remain auditable.
const licenseOverrides = new Map([
  ['buildcheck@0.0.7', {
    license: 'MIT',
    evidence: 'https://github.com/mscdex/buildcheck/blob/master/LICENSE',
  }],
  ['cpu-features@0.0.10', {
    license: 'MIT',
    evidence: 'https://github.com/mscdex/cpu-features/blob/master/LICENSE',
  }],
  ['ssh2@1.17.0', {
    license: 'MIT',
    evidence: 'https://github.com/mscdex/ssh2/blob/master/LICENSE',
  }],
]);

const packages = new Map();
scanLockfile(path.join(root, 'package-lock.json'), 'server');
scanLockfile(path.join(root, 'client', 'package-lock.json'), 'client');

const unresolved = [];
const restricted = [];
for (const item of packages.values()) {
  if (!item.license) unresolved.push(item.id);
  if (/\b(?:AGPL|GPL|LGPL|SSPL|BUSL)-/i.test(item.license ?? '')) {
    restricted.push(`${item.id} (${item.license})`);
  }
}

if (unresolved.length > 0 || restricted.length > 0) {
  if (unresolved.length > 0) console.error(`Missing license evidence: ${unresolved.join(', ')}`);
  if (restricted.length > 0) console.error(`License requires explicit legal review: ${restricted.join(', ')}`);
  process.exit(1);
}

const sorted = [...packages.values()].sort((a, b) => a.id.localeCompare(b.id));
const lines = [
  '# Third-Party Notices',
  '',
  'This product includes the npm packages listed below. The inventory is generated from the complete dependency trees locked by `package-lock.json` and `client/package-lock.json`, including platform-specific optional packages.',
  '',
  'The applicable license texts and copyright notices remain in each installed package. This inventory is provided for attribution and review; it does not replace those license terms.',
  '',
  '| Package | License | Used by | Evidence override |',
  '| --- | --- | --- | --- |',
  ...sorted.map(item => `| ${escapeCell(item.id)} | ${escapeCell(item.license)} | ${[...item.roots].sort().join(', ')} | ${item.evidence ? `[upstream](${item.evidence})` : ''} |`),
  '',
  `Total unique packages: ${sorted.length}.`,
];
const generated = `${lines.join('\n')}\n`;

if (checkMode) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n') !== generated) {
    console.error('THIRD_PARTY_NOTICES.md is stale. Run npm run licenses:generate and commit the result.');
    process.exit(1);
  }
  console.log(`Third-party license inventory verified (${sorted.length} unique packages).`);
} else {
  fs.writeFileSync(outputPath, generated, 'utf8');
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${sorted.length} unique packages).`);
}

function scanLockfile(lockPath, sourceRoot) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error(`${path.relative(root, lockPath)} must use npm lockfileVersion 3`);
  }
  for (const [packagePath, manifest] of Object.entries(lock.packages)) {
    const marker = 'node_modules/';
    const markerIndex = packagePath.lastIndexOf(marker);
    if (markerIndex < 0 || !manifest.version) continue;
    const name = packagePath.slice(markerIndex + marker.length);
    if (!name || name.includes('/node_modules/')) continue;
    const id = `${name}@${manifest.version}`;
    const override = licenseOverrides.get(id);
    const license = override?.license ?? declaredLicense(manifest);
    const existing = packages.get(id);
    if (existing) {
      existing.roots.add(sourceRoot);
    } else {
      packages.set(id, { id, license, evidence: override?.evidence, roots: new Set([sourceRoot]) });
    }
  }
}

function declaredLicense(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim();
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses.map(value => typeof value === 'string' ? value : value?.type).filter(Boolean);
    if (values.length > 0) return values.join(' OR ');
  }
  return null;
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|');
}
