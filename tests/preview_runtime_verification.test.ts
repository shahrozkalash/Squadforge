import test from 'node:test';
import assert from 'node:assert';
import {
  PreviewGenerator,
  resolveAllowedDependency,
  BROWSER_PACKAGE_REGISTRY,
  isForbiddenServerModule,
  getEffectivePackageVersion,
} from '../server/swarm/previewGenerator.js';
import { BrowserRuntimeVerifier } from '../server/swarm/runtimeVerifier.js';
import type { ProjectFile } from '../server/types.js';

test('Preview Entry Point & Metadata Integrity', async (t) => {
  await t.test('preserves the actual React entry point returned by preview generator', async () => {
    const files: ProjectFile[] = [
      {
        path: 'src/App.tsx',
        content: `
import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-8">
      <h1>SquadForge App</h1>
      <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>
    </div>
  );
}
        `,
        version: 1,
        history: []
      },
    ];

    const preview = PreviewGenerator.generateLivePreview('fullstack', 'build-entry-test', files);

    // Requirement 2: Preserve actual entry point returned by preview generator. Never hardcode to preview.html!
    assert.notStrictEqual(preview.entryPoint, 'preview.html');
    assert.strictEqual(preview.entryPoint, 'src/__preview_root.tsx');
    assert.strictEqual(preview.mode, 'real_application');
    assert.ok(preview.html.includes('id="root"'));
    assert.ok(preview.html.includes('<script type="importmap">'));
  });

  await t.test('handles static HTML projects and preserves index.html entry point', async () => {
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content: `<!DOCTYPE html><html lang="en"><head><title>Static App</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><h1>Pure HTML</h1></body></html>`,
        version: 1,
        history: []
      },
    ];

    const preview = PreviewGenerator.generateLivePreview('static', 'build-static-test', files);

    assert.strictEqual(preview.entryPoint, 'index.html');
    assert.strictEqual(preview.mode, 'static_html');
    assert.ok(preview.html.includes('Pure HTML'));
  });

  await t.test('marks fallback demonstration truthfully when broken or fallback code is provided', async () => {
    const files: ProjectFile[] = [
      {
        path: 'src/App.tsx',
        content: `import React from 'react'; export default function App() { return <div>BROKEN <<<<< }`,
        version: 1,
        history: []
      },
    ];

    const preview = PreviewGenerator.generateInteractivePreview('Broken App', files, 'fullstack');

    assert.strictEqual(preview.mode, 'fallback_preview');
    assert.ok(preview.html.includes('Fallback Demonstration'));
    assert.ok(preview.diagnosticInfo?.includes('Bundle compilation failed'));
  });
});

test('Dependency Resolution: Allowlist, Versions & Forbidden Modules', async (t) => {
  await t.test('verifies lucide-react version matches package.json pinned version 0.546.0', () => {
    const lucideVersion = getEffectivePackageVersion('lucide-react');
    assert.strictEqual(lucideVersion, '0.546.0');
    assert.ok(BROWSER_PACKAGE_REGISTRY['lucide-react'].url?.includes('0.546.0'));
  });

  await t.test('resolves standard and subpath imports accurately', () => {
    const reactRes = resolveAllowedDependency('react');
    assert.ok(reactRes);
    assert.strictEqual(reactRes?.packageName, 'react');
    assert.ok(reactRes?.esmUrl.includes('react@'));

    // Subpath resolution for icon libraries
    const iconSubpath = resolveAllowedDependency('lucide-react/icons/star');
    assert.ok(iconSubpath);
    assert.strictEqual(iconSubpath?.packageName, 'lucide-react');
    assert.strictEqual(iconSubpath?.subpath, 'icons/star');
    assert.ok(iconSubpath?.esmUrl.includes('/icons/star'));
  });

  await t.test('identifies and blocks forbidden server modules', () => {
    assert.strictEqual(isForbiddenServerModule('fs'), true);
    assert.strictEqual(isForbiddenServerModule('node:fs'), true);
    assert.strictEqual(isForbiddenServerModule('child_process'), true);
    assert.strictEqual(isForbiddenServerModule('express'), true);
    assert.strictEqual(isForbiddenServerModule('dotenv'), true);
    assert.strictEqual(isForbiddenServerModule('react'), false);
    assert.strictEqual(isForbiddenServerModule('lucide-react'), false);
  });
});

test('Browser Runtime Verifier: Comprehensive Automated Verification', async (t) => {
  await t.test('verifies a fully valid React preview document', async () => {
    const files: ProjectFile[] = [
      {
        path: 'src/App.tsx',
        content: `
import React, { useState } from 'react';
export default function App() {
  const [active, setActive] = useState(false);
  return (
    <div className="min-h-screen bg-neutral-900 text-white p-6 flex flex-col">
      <header className="mb-4"><h1 className="text-2xl font-bold">Verified App</h1></header>
      <main className="flex-1">
        <p className="text-gray-300">Operational Dashboard</p>
        <button onClick={() => setActive(!active)} className="mt-4 px-4 py-2 bg-blue-600 rounded">
          Toggle: {active ? 'On' : 'Off'}
        </button>
      </main>
    </div>
  );
}
        `,
        version: 1,
        history: []
      },
    ];

    const preview = PreviewGenerator.generateLivePreview('saas_dashboard', 'Verified App', files);
    const report = BrowserRuntimeVerifier.verifyPreviewRuntime(preview, files);

    assert.strictEqual(report.verified, true);
    assert.strictEqual(report.verdict, 'verified');
    assert.strictEqual(report.domMountVerified, true);
    assert.strictEqual(report.meaningfulContentRendered, true);
    assert.strictEqual(report.interactiveControlsVerified, true);
    assert.strictEqual(report.responsiveLayoutVerified, true);
    assert.strictEqual(report.dependencyIntegrityVerified, true);
    assert.strictEqual(report.errors.length, 0);
    assert.ok(report.checks.length >= 7);
  });

  await t.test('fails verification when document is missing viewport or mount target', async () => {
    const brokenPreview = {
      html: `<html><head><title>Broken</title></head><body><p>Missing root and viewport</p></body></html>`,
      mode: 'real_application' as const,
      entryPoint: 'src/App.tsx',
    };

    const report = BrowserRuntimeVerifier.verifyPreviewRuntime(brokenPreview, []);

    assert.strictEqual(report.verified, false);
    assert.strictEqual(report.domMountVerified, false);
    assert.strictEqual(report.responsiveLayoutVerified, false);
    assert.ok(report.errors.length > 0);
  });

  await t.test('fails verification when runtime error overlay or diagnostic failure is detected', async () => {
    const errorPreview = {
      html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Err</title></head><body><div id="root"></div></body></html>`,
      mode: 'real_application' as const,
      entryPoint: 'src/App.tsx',
      runtimeErrors: ['Uncaught ReferenceError: variable is not defined'],
      diagnosticInfo: 'Bundle compilation failed with 1 syntax error',
    };

    const report = BrowserRuntimeVerifier.verifyPreviewRuntime(errorPreview, []);

    assert.strictEqual(report.verified, false);
    assert.ok(report.errors.length > 0);
  });
});
