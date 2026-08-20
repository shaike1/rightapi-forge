import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const productHtml = path.join(root, 'public', 'product.html');
const productCss = path.join(root, 'public', 'product.css');
const productHero = path.join(root, 'public', 'rightapi-forge-operations-hero.png');
const serverSource = path.join(root, 'src', 'web', 'server.ts');

test('root route serves the public product page separately from the console', () => {
  const source = readFileSync(serverSource, 'utf8');

  assert.match(source, /app\.get\('\/', \(_req, res\) => \{\s*res\.sendFile\('product\.html'/);
  assert.doesNotMatch(source, /app\.get\('\/', \(_req, res\) => \{[\s\S]{0,300}res\.redirect\(302, '\/app\/'\)/);
  assert.match(source, /app\.get\("\/app",/);
  assert.match(source, /app\.get\("\/app\/\*",/);
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
});

test('public product page ships local presentation assets', () => {
  const css = readFileSync(productCss, 'utf8');

  assert.match(css, /\.hero-image/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.ok(statSync(productHero).size > 100_000, 'hero image should be a substantive raster asset');
});
