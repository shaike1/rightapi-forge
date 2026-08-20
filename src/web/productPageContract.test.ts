import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const productHtml = path.join(root, 'public', 'product.html');
const productCss = path.join(root, 'public', 'product.css');
const productHero = path.join(root, 'public', 'rightapi-forge-operations-hero.png');
const productRunbooks = path.join(root, 'public', 'rightapi-forge-runbooks.png');
const productBuilder = path.join(root, 'public', 'rightapi-forge-tool-builder.png');
const productDocs = path.join(root, 'public', 'product-docs.html');
const serverSource = path.join(root, 'src', 'web', 'server.ts');

test('root route serves the public product page separately from the console', () => {
  const source = readFileSync(serverSource, 'utf8');

  assert.match(source, /app\.get\('\/', \(_req, res\) => \{\s*res\.sendFile\('product\.html'/);
  assert.doesNotMatch(source, /app\.get\('\/', \(_req, res\) => \{[\s\S]{0,300}res\.redirect\(302, '\/app\/'\)/);
  assert.match(source, /app\.get\("\/app",/);
  assert.match(source, /app\.get\("\/app\/\*",/);
  assert.match(source, /app\.get\('\/docs'/);
});

test('public product page defines the platform and exposes primary actions', () => {
  const html = readFileSync(productHtml, 'utf8');

  assert.match(html, /<h1 id="hero-title">RightAPI Forge<\/h1>/);
  assert.match(html, /Self-hosted governed AI operations/);
  assert.match(html, /Governed execution lifecycle/);
  assert.match(html, /System architecture/);
  assert.match(html, /Governance by construction/);
  assert.match(html, /href="\/app\/"/);
  assert.match(html, /github\.com\/shaike1\/rightapi-forge/);
  assert.match(html, /mailto:info@right-api\.com/);
  assert.match(html, /data-demo-form/);
  assert.match(html, /rightapi-forge-runbooks\.png/);
  assert.match(html, /rightapi-forge-tool-builder\.png/);
  assert.match(readFileSync(productDocs, 'utf8'), /Deploy, govern, and operate RightAPI Forge/);
});

test('public product page ships local presentation assets', () => {
  const css = readFileSync(productCss, 'utf8');

  assert.match(css, /\.hero-image/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.ok(statSync(productHero).size > 100_000, 'hero image should be a substantive raster asset');
  assert.ok(statSync(productRunbooks).size > 80_000, 'runbook screenshot should be a substantive raster asset');
  assert.ok(statSync(productBuilder).size > 80_000, 'builder screenshot should be a substantive raster asset');
});
