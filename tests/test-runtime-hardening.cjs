'use strict';

const { ActionRuntime } = require('../core/action-runtime.cjs');
const { AuditEngine } = require('../core/audit-engine.cjs');
const { ExecutionEngine } = require('../core/execution-engine.cjs');
const { DecisionEngine } = require('../core/decision-engine.cjs');
const { GateEngine } = require('../core/gate-engine.cjs');
const {
  CapabilityRuntime,
  isCompletedExecution,
} = require('../products/phone-friend/runtime/capability-runtime.cjs');
const {
  ConversationOrchestrator,
  RESPONSE_KIND,
} = require('../products/phone-friend/conversation/orchestrator.cjs');
const { AndroidContactApi } = require('../adapters/web/android-contact-api.cjs');
const { PhoneFriendWebApi } = require('../adapters/web/phone-friend-api.cjs');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${label}`);
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++;
    console.error(`  ❌ FAIL: ${label}`);
  } catch {
    passed++;
    console.log(`  ✅ ${label}`);
  }
}

function makeAction(runtime, key = 'hardening-action', opts = {}) {
  return runtime.prepare({
    decision: {
      id: key,
      domain: 'GENERAL_ASSISTANT',
      action: 'READ',
      risk: 'LOW',
      reversibility: 'FULLY_REVERSIBLE',
      required_gates: [],
    },
    gate_result: {
      result: 'ALLOW',
      execute_ready: false,
      checks: {},
      audit: { decision_id: key },
    },
    connector: 'test',
    idempotency_key: key,
    reversible: opts.reversible,
  });
}

async function run() {
  console.log('\n═══ Runtime Hardening Tests ═══\n');

  console.log('▸ TC-1: ActionRuntime status transition enforcement');
  {
    const runtime = new ActionRuntime();
    const action = makeAction(runtime);

    assertThrows(
      () => runtime.setStatus(action.runtime_action_id, 'VERIFIED'),
      'READY → VERIFIED jump denied'
    );
    runtime.setStatus(action.runtime_action_id, 'EXECUTING');
    runtime.setStatus(action.runtime_action_id, 'SUCCEEDED');
    runtime.setStatus(action.runtime_action_id, 'VERIFY_FAILED');
    runtime.setStatus(action.runtime_action_id, 'VERIFY_FAILED');
    assert(
      runtime.get(action.runtime_action_id).status === 'VERIFY_FAILED',
      'VERIFY_FAILED re-verification failure remains valid'
    );
    runtime.setStatus(action.runtime_action_id, 'VERIFIED');
    assertThrows(
      () => runtime.setStatus(action.runtime_action_id, 'FAILED'),
      'terminal VERIFIED → FAILED denied'
    );

    const irreversible = makeAction(
      runtime,
      'irreversible-rollback',
      { reversible: false }
    );
    runtime.setStatus(irreversible.runtime_action_id, 'EXECUTING');
    runtime.setStatus(irreversible.runtime_action_id, 'SUCCEEDED');
    assertThrows(
      () => runtime.setStatus(irreversible.runtime_action_id, 'ROLLED_BACK'),
      'irreversible action rollback denied by runtime'
    );
  }

  console.log('▸ TC-2: Capability executed means completed, not attempted');
  {
    const audit = new AuditEngine();
    const actions = new ActionRuntime({ auditEngine: audit });
    const executions = new ExecutionEngine({
      actionRuntime: actions,
      auditEngine: audit,
      connectors: {
        failed: {
          async execute() {
            throw new Error('expected_failure');
          },
        },
        verifyFailed: {
          async execute() { return { ok: true }; },
          async verify() { return { ok: false, reason: 'not_applied' }; },
        },
      },
    });
    const capability = new CapabilityRuntime({
      decisionEngine: new DecisionEngine(),
      gateEngine: new GateEngine(),
      actionRuntime: actions,
      executionEngine: executions,
    });
    const intent = { capability: 'CHAT', title: '상태 확인', slots: {} };

    const failedResult = await capability.executeIntent({
      intent,
      connector: 'failed',
      idempotency_key: 'capability-failed',
    });
    const verifyFailed = await capability.executeIntent({
      intent,
      connector: 'verifyFailed',
      idempotency_key: 'capability-verify-failed',
    });

    assert(failedResult.status === 'FAILED', 'FAILED response preserved');
    assert(failedResult.attempted === true, 'FAILED was attempted');
    assert(failedResult.executed === false, 'FAILED is not executed');
    assert(verifyFailed.status === 'VERIFY_FAILED', 'VERIFY_FAILED response preserved');
    assert(verifyFailed.attempted === true, 'VERIFY_FAILED was attempted');
    assert(verifyFailed.executed === false, 'VERIFY_FAILED is not executed');
    assert(isCompletedExecution('ROLLED_BACK') === false, 'ROLLED_BACK is not executed');
  }

  console.log('▸ TC-2b: failed execution cannot invoke rollback connector');
  {
    let rollbackCalls = 0;
    const audit = new AuditEngine();
    const actions = new ActionRuntime({ auditEngine: audit });
    const action = makeAction(actions, 'rollback-after-failure');
    const executions = new ExecutionEngine({
      actionRuntime: actions,
      auditEngine: audit,
      connectors: {
        test: {
          async execute() { throw new Error('failure'); },
          async rollback() { rollbackCalls++; return { ok: true }; },
        },
      },
    });
    const failedExecution = await executions.execute(action.runtime_action_id);
    try {
      await executions.rollback(failedExecution.execution_id);
      assert(false, 'FAILED rollback denied');
    } catch {
      assert(true, 'FAILED rollback denied');
    }
    assert(rollbackCalls === 0, 'rollback connector not invoked');
  }

  console.log('▸ TC-3: conversation subject/device mismatch is denied and audited');
  {
    const audit = new AuditEngine();
    const conversation = new ConversationOrchestrator({ auditEngine: audit });
    const first = conversation.handle({
      utterance: '오늘 일정 알려줘',
      subject: 'user:bound-a',
      device_id: 'device:bound-a',
      now: '2026-09-05T00:00:00.000Z',
    });
    const denied = conversation.handle({
      utterance: '응',
      session_id: first.session.id,
      subject: 'user:bound-b',
      device_id: 'device:bound-a',
      now: '2026-09-05T00:00:01.000Z',
    });

    assert(denied.response.kind === RESPONSE_KIND.DENY, 'binding mismatch DENY');
    assert(
      audit.list().some((entry) => entry.event === 'CONVERSATION_SESSION_BINDING_DENIED'),
      'binding mismatch audit'
    );
  }

  console.log('▸ TC-4: audit never stores raw SMS, phone, or contact values');
  {
    const audit = new AuditEngine();
    audit.append({
      event: 'SENSITIVE_TEST',
      data: {
        message: { content: '인증번호 1234를 보내세요' },
        contacts: [{ name: '홍길동', phones: ['010-1234-5678'] }],
        continuation_token: 'continuation-secret-value',
        resource_id: 'contact-1',
      },
    });
    const serialized = JSON.stringify(audit.list());
    assert(!serialized.includes('인증번호 1234'), 'SMS body redacted');
    assert(!serialized.includes('010-1234-5678'), 'phone redacted');
    assert(!serialized.includes('홍길동'), 'contact name redacted');
    assert(!serialized.includes('continuation-secret-value'), 'continuation token redacted');
    assert(serialized.includes('contact-1'), 'resource id retained');
    assert(audit.verifyChain().ok, 'redacted audit chain valid');
  }

  console.log('▸ TC-5: Android endpoint is fail-closed and uses Core path');
  {
    const api = new AndroidContactApi();
    const sample = [
      { id: '1', name: '홍길동', phones: ['010-1234-5678'] },
      { id: '2', name: '홍길동', phones: ['01012345678'] },
    ];
    const denied = await api.analyze({
      client: 'ANDROID',
      contacts: sample,
    });
    const ok = await api.analyze({
      client: 'ANDROID',
      permission_granted: true,
      contacts: sample,
      subject: 'user:android',
      device_id: 'device:android',
      idempotency_key: 'android-core-path',
    });
    const events = api.getAudit().list();
    const serialized = JSON.stringify(events);

    assert(denied.error === 'permission_required', 'missing permission denied');
    assert(ok.ok === true && ok.mutated === false, 'read/analyze/propose succeeds');
    assert(events.some((entry) => entry.event === 'ACTION_READY'), 'Core runtime audited');
    assert(events.some((entry) => entry.event === 'VERIFICATION_SUCCEEDED'), 'Core verification audited');
    assert(!serialized.includes('010-1234-5678'), 'endpoint audit phone redacted');
    assert(!serialized.includes('홍길동'), 'endpoint audit contact redacted');
  }

  console.log('▸ TC-6: public Web continuation token prevents session hijack');
  {
    const api = new PhoneFriendWebApi();
    const first = await api.handleTurn({
      utterance: '엄마한테 조금 늦는다고 문자 보내줘',
      subject: 'user:bound',
      device_id: 'device:bound',
      now: '2026-09-05T00:00:00.000Z',
    });
    const token = first.continuation_token;
    const base = {
      utterance: '응',
      session_id: first.session_id,
      subject: 'user:bound',
      device_id: 'device:bound',
      now: '2026-09-05T00:00:01.000Z',
    };
    const missing = await api.handleTurn(base);
    const malformed = await api.handleTurn({
      ...base,
      continuation_token: 'not-the-issued-token',
    });
    const missingBinding = await api.handleTurn({
      utterance: '응',
      session_id: first.session_id,
      continuation_token: token,
      now: '2026-09-05T00:00:01.000Z',
    });
    const accepted = await api.handleTurn({
      ...base,
      continuation_token: token,
    });
    const stored = api.runtime.conversation.sessions.store.get(
      `conv:${first.session_id}`
    );
    const audit = JSON.stringify(api.runtime.getAudit().list());

    assert(typeof token === 'string' && token.length >= 40, 'token issued once');
    assert(missing.status === 'DENY', 'missing token DENY');
    assert(malformed.status === 'DENY', 'malformed token DENY');
    assert(missingBinding.status === 'DENY', 'missing subject/device DENY');
    assert(accepted.status === 'COMPLETE', 'valid token continuation accepted');
    assert(accepted.continuation_token === token, 'accepted token returned to client');
    assert(
      typeof stored.continuation_token_hash === 'string' &&
        !JSON.stringify(stored).includes(token),
      'stored session retains hash only'
    );
    assert(!audit.includes(token), 'raw continuation token absent from Audit');
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
