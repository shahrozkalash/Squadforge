/**
 * Factory Phase F1 — live provider proof and model capability baseline.
 *
 * This suite pins the registry facts the F1 capability matrix rests on:
 * the exact 10 base models + 4 specialized variants, their provider
 * (transport) classification, and two-way role integrity between
 * AGENT_SPECS and the registry. It also pins the platform's honesty
 * contract for the F1 negative result: with no provider keys configured,
 * the SmartRouter must refuse by name — it must never fabricate a
 * generation. (Genuine live verification stays in the gated test in
 * tests/phase33_ai_reliability_security.test.ts.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { modelRegistry, AGENT_SPECS, INITIAL_MODEL_REGISTRY, AGENT_ROLE_ALIASES, canonicalAgentRole } from '../server/modelRegistry.js';
import { smartRouter } from '../server/smartRouter.js';

const BASE_MODELS = [
  'gpt-4o', 'claude', 'llama', 'mistral', 'nemotron',
  'gemini', 'deepseek', 'qwen', 'grok', 'codex'
];
const VARIANT_MODELS = ['gemini-fullstack', 'claude-uiux', 'deepseek-perf', 'mistral-docs'];
const GEMINI_TRANSPORT = new Set(['gemini', 'gemini-fullstack']);

test('F1 registry: all 10 base models and 4 variants are registered', () => {
  const ids = new Set(INITIAL_MODEL_REGISTRY.map((m) => m.id));
  for (const id of [...BASE_MODELS, ...VARIANT_MODELS]) {
    assert.ok(ids.has(id), `registry must contain ${id}`);
  }
});

test('F1 registry: every entry carries a provider transport and an upstream model id', () => {
  for (const m of INITIAL_MODEL_REGISTRY) {
    assert.ok(m.provider === 'gemini' || m.provider === 'openrouter',
      `${m.id} must declare a known transport, got ${m.provider}`);
    assert.equal(m.provider, GEMINI_TRANSPORT.has(m.id) ? 'gemini' : 'openrouter',
      `${m.id} transport classification`);
    assert.ok(typeof m.providerModel === 'string' && m.providerModel.length > 0,
      `${m.id} must name its upstream provider model`);
  }
});

test('F1 roles: every AGENT_SPECS role is assigned a registered model, and every registry role resolves', () => {
  const ids = new Set(INITIAL_MODEL_REGISTRY.map((m) => m.id));
  // F1 finding (documented in the capability matrix): three AGENT_SPECS
  // roles are aliases — database_engineer, integration_engineer,
  // qa_engineer — whose names no registry entry carries as its
  // agentRole. F1 pinned them as unresolvable via getByRole().
  // Factory Phase F5 RESOLVED the finding: AGENT_ROLE_ALIASES maps each
  // alias to its canonical specialist role and getByRole() canonicalizes
  // through it, and the three AGENT_SPECS assignedModelId values that
  // disagreed with the registry binding (ui_ux_designer,
  // performance_engineer, documentation_engineer) were aligned to it.
  // The alias set is still pinned by name here so it can never change
  // silently, and every role must now resolve — via getByRole() — to
  // exactly the model AGENT_SPECS assigns to it.
  assert.deepEqual(Object.keys(AGENT_ROLE_ALIASES).sort(),
    ['database_engineer', 'integration_engineer', 'qa_engineer'],
    'the role alias set must remain exactly the three F1-documented aliases');
  for (const [role, spec] of Object.entries(AGENT_SPECS)) {
    assert.ok(ids.has(spec.assignedModelId),
      `role ${role} is assigned to unregistered model ${spec.assignedModelId}`);
    const resolved = modelRegistry.getByRole(role as never);
    assert.ok(resolved, `getByRole(${role}) must resolve to a registered model`);
    assert.equal(resolved!.id, spec.assignedModelId,
      `getByRole(${role}) must return the model AGENT_SPECS assigns (${spec.assignedModelId}), got ${resolved!.id}`);
    if (role in AGENT_ROLE_ALIASES) {
      assert.equal(canonicalAgentRole(role as never),
        modelRegistry.getById(spec.assignedModelId)?.agentRole,
        `alias ${role} must canonicalize to the role its assigned model carries`);
    }
  }
  for (const m of INITIAL_MODEL_REGISTRY) {
    if (m.agentRole) {
      assert.ok(AGENT_SPECS[m.agentRole], `model ${m.id} claims unknown role ${m.agentRole}`);
      assert.equal(modelRegistry.getByRole(m.agentRole)?.id, m.id,
        `getByRole(${m.agentRole}) must return ${m.id}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Honesty contract: no keys -> named refusal, never a fabricated success.
// Env is saved and restored around these two tests.
// ---------------------------------------------------------------------------
const KEY_NAMES = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const name of KEY_NAMES) savedEnv[name] = process.env[name];
before(() => {
  for (const name of KEY_NAMES) delete process.env[name];
});
after(() => {
  for (const name of KEY_NAMES) {
    const v = savedEnv[name];
    if (v !== undefined) process.env[name] = v;
  }
});

test('F1 honesty: Gemini path refuses by name when GEMINI_API_KEY is absent', async () => {
  const result: any = await (smartRouter as any).executeSmartRequest({
    requestedModelId: 'gemini-fullstack',
    prompt: 'Respond with {"report":{"summary":"probe"}}',
    taskComplexity: 'standard',
    bypassCache: true
  });
  assert.equal(result.success, false);
  assert.match(String(result.error), /GEMINI_API_KEY/);
});

test('F1 honesty: OpenRouter path refuses by name when OPENROUTER_API_KEY is absent', async () => {
  const result: any = await (smartRouter as any).executeSmartRequest({
    requestedModelId: 'gpt-4o',
    prompt: 'Respond with {"report":{"summary":"probe"}}',
    taskComplexity: 'standard',
    bypassCache: true
  });
  assert.equal(result.success, false);
  assert.match(String(result.error), /OPENROUTER_API_KEY/);
});
