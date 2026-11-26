/**
 * Workflow reliability guards (2026-11-26).
 *
 * The Phase 32/34/35 genuine-build workflows report results via
 * harness RESULT_JSON lines captured with `| tee`. Without
 * pipefail, tee's exit code (0) masked harness failures: several
 * Phase 34 runs showed a green GitHub headline while the build
 * had actually failed (apkBytes: 0). These tests pin the
 * hardening in place:
 *   - every step that pipes through tee sets `set -eo pipefail`,
 *   - every workflow ends its evidence steps with an
 *     always-run validation gate that fails the workflow when
 *     the captured evidence is missing, failed, or invalid.
 * The gate scripts themselves were verified locally against the
 * captured outputs of real passing and failing runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const WORKFLOWS: Record<string, { gateNeedles: string[] }> = {
  '.github/workflows/phase32-execution-verify.yml': {
    gateNeedles: ['# tests 7', '# pass 7', '# fail 0', '# skipped 0']
  },
  '.github/workflows/phase34-android-video-editor.yml': {
    gateNeedles: ['"ok":true', 'apkBytes', 'UNIT_TESTS tests=19 failures=0 errors=0 skipped=0', 'apksigner verification strictly PASSED', '.android_artifacts']
  },
  '.github/workflows/phase37-android-export-parity.yml': {
    gateNeedles: ['"ok":true', 'apkBytes', 'UNIT_TESTS tests=19 failures=0 errors=0 skipped=0', 'INSTRUMENTED status=pass', 'EXPORT_VERIFY', 'export_parity_output.mp4', 'All Phase 37 checks passed.']
  },
  '.github/workflows/phase35-ios-video-editor.yml': {
    gateNeedles: ['"ok":true', 'appBytes', 'ClipForge.app']
  }
};

/** Split a workflow file into step blocks (text-based; the files are small and regular). */
function stepBlocks(yaml: string): string[] {
  const idx: number[] = [];
  const lines = yaml.split('\n');
  lines.forEach((line, i) => {
    if (/^\s+- name:/.test(line) || /^\s+- uses:/.test(line)) idx.push(i);
  });
  idx.push(lines.length);
  const blocks: string[] = [];
  for (let k = 0; k + 1 < idx.length; k++) {
    blocks.push(lines.slice(idx[k], idx[k + 1]).join('\n'));
  }
  return blocks;
}

describe('genuine-build workflow reliability', () => {
  for (const [file, { gateNeedles }] of Object.entries(WORKFLOWS)) {
    describe(file, () => {
      const yaml = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8');
      const blocks = stepBlocks(yaml);

      test('every step that pipes through tee runs with pipefail', () => {
        const teeSteps = blocks.filter((b) => b.includes('| tee'));
        assert.ok(teeSteps.length > 0, 'expected at least one tee step');
        for (const step of teeSteps) {
          assert.ok(
            step.includes('set -eo pipefail'),
            `step must set -eo pipefail so a harness failure cannot be masked by tee:\n${step.split('\n')[0]}`
          );
        }
      });

      test('has an always-run validation gate over the captured evidence', () => {
        const gate = blocks.find((b) => b.includes('Validate genuine results'));
        assert.ok(gate, 'a "Validate genuine results" step must exist');
        assert.ok(gate!.includes('if: always()'), 'the gate must run even when earlier steps fail');
        assert.ok(gate!.includes('exit 1'), 'the gate must be able to fail the workflow');
        for (const needle of gateNeedles) {
          assert.ok(gate!.includes(needle), `gate must check for: ${needle}`);
        }
      });
    });
  }
});
