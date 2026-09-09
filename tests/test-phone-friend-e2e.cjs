'use strict';

/**
 * PHONE FRIEND Capability Integration E2E
 * Conversation → Intent → Policy → Decision → Gate
 * → ActionRuntime → Execution → Connector → Verify → Audit
 */

const {
  ACTION_RUNTIME_STATUS,
} = require('../core/action-runtime.cjs');

const {
  ConversationSessionStore,
} = require('../products/phone-friend/sessions/conversation-session-store.cjs');

const {
  PhoneFriendRuntime,
  PIPELINE_RESULT,
} = require('../products/phone-friend/runtime/phone-friend-runtime.cjs');

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

const BASE = '2026-09-04T11:00:00+09:00';

async function run() {
  console.log('\n═══ PHONE FRIEND Integration E2E ═══\n');

  const runtime = new PhoneFriendRuntime();
  const audit = runtime.getAudit();
  const device = runtime.getDevice();

  console.log('▸ E2E-1: 오늘 일정 알려줘 → CALENDAR_READ');
  {
    const result = await runtime.handle({
      utterance: '오늘 일정 알려줘',
      subject: 'user:e2e',
      idempotency_key: 'e2e-cal-read-1',
      now: BASE,
    });

    assert(result.scenario === 'CALENDAR_READ', 'CALENDAR_READ 시나리오');
    assert(result.executed === true, '일정 조회 실행');
    assert(
      result.capability_result &&
        result.capability_result.execution &&
        (result.capability_result.execution.status ===
          ACTION_RUNTIME_STATUS.VERIFIED ||
          result.capability_result.execution.status ===
            ACTION_RUNTIME_STATUS.SUCCEEDED),
      '조회 VERIFIED/SUCCEEDED'
    );
    assert(result.authority_granted === false, 'Authority false');
  }

  console.log('▸ E2E-2: 병원 일정 등록 confirm → WRITE');
  {
    const ask = await runtime.handle({
      utterance: '내일 3시에 병원 일정 넣어줘',
      subject: 'user:e2e',
      now: BASE,
    });

    assert(ask.status === 'WAITING_CONFIRMATION', '일정 등록 확인 요청');
    assert(ask.executed === false, '확인 전 미실행');

    const sessionId = ask.conversation.session.id;

    const done = await runtime.handle({
      utterance: '응',
      session_id: sessionId,
      subject: 'user:e2e',
      idempotency_key: 'e2e-cal-write-1',
      now: '2026-09-04T11:01:00+09:00',
    });

    assert(done.executed === true, '확인 후 일정 등록 실행');
    assert(
      done.capability_result.execution.connector_result.event.title ===
        '병원',
      '병원 일정 생성'
    );
    assert(
      done.capability_result.execution.status ===
        ACTION_RUNTIME_STATUS.VERIFIED ||
        done.capability_result.execution.status ===
          ACTION_RUNTIME_STATUS.SUCCEEDED,
      'WRITE VERIFIED'
    );
  }

  console.log('▸ E2E-3: 문자 발송 confirm + idempotency');
  {
    const ask = await runtime.handle({
      utterance: '엄마한테 조금 늦는다고 문자 보내줘',
      subject: 'user:e2e',
      now: BASE,
    });

    assert(ask.status === 'WAITING_CONFIRMATION', '문자 확인 요청');
    const sessionId = ask.conversation.session.id;
    const before = device.messaging.send_count;

    const sent = await runtime.handle({
      utterance: '응',
      session_id: sessionId,
      subject: 'user:e2e',
      idempotency_key: 'e2e-msg-1',
      now: '2026-09-04T11:02:00+09:00',
    });

    assert(sent.executed === true, '문자 1회 발송');
    assert(
      sent.capability_result.execution.connector_result.message.to ===
        '엄마',
      'recipient 엄마'
    );

    const again = await runtime.messaging.send(runtime.capability, {
      subject: 'user:e2e',
      recipient: '엄마',
      content: '조금 늦는다고',
      idempotency_key: 'e2e-msg-1',
      policy_ok: true,
      now: '2026-09-04T11:03:00+09:00',
    });

    assert(
      device.messaging.send_count === before + 1,
      '중복 idempotency 재발송 금지'
    );
    assert(
      again.execution.idempotent_replay === true,
      'idempotent replay'
    );
  }

  console.log('▸ E2E-3b: 문자 조회 MESSAGE_READ');
  {
    const result = await runtime.handle({
      utterance: '엄마 문자 확인해줘',
      subject: 'user:e2e',
      idempotency_key: 'e2e-msg-read-1',
      now: BASE,
    });

    assert(result.scenario === 'MESSAGE_READ', 'MESSAGE_READ');
    assert(result.executed === true, '문자 조회 실행');
    const messages =
      result.capability_result.execution.connector_result.messages;
    assert(
      Array.isArray(messages) && messages.length >= 1,
      '엄마 관련 문자 조회'
    );
    assert(
      messages.every(
        (message) => message.from === '엄마' || message.to === '엄마'
      ),
      '조회 결과가 엄마 관련'
    );
    assert(result.authority_granted === false, 'READ ≠ Authority');
  }

  console.log('▸ E2E-4: 이상 문자 SAFETY WARN');
  {
    const result = await runtime.handle({
      utterance: '이 문자 이상한데 봐줘',
      subject: 'user:e2e',
      idempotency_key: 'e2e-safety-1',
      now: BASE,
    });

    assert(result.scenario === 'SAFETY_TEXT', 'SAFETY_TEXT');
    assert(result.status === 'WARN', 'WARN');
    assert(
      ['HIGH', 'CRITICAL'].includes(result.risk),
      '위험 findings HIGH+'
    );
    assert(
      Array.isArray(result.findings) && result.findings.length > 0,
      'findings 존재'
    );
    assert(result.authority_granted === false, 'Safety ≠ Authority');
  }

  console.log('▸ E2E-5: 안전 파일 → PDF 변환');
  {
    const result = await runtime.handle({
      utterance: '이 파일 PDF로 바꿔줘',
      subject: 'user:e2e',
      filename: 'document.txt',
      source_text: 'hello arkaon',
      idempotency_key: 'e2e-doc-safe',
      safety_idempotency_key: 'e2e-doc-safe-scan',
      now: BASE,
    });

    assert(
      result.safety_decision &&
        result.safety_decision.pipeline_result ===
          PIPELINE_RESULT.PROCEED,
      'LOW → PROCEED'
    );
    assert(result.executed === true, '변환 실행');
    assert(
      result.capability_result.conversion_result.execution
        .connector_result.document.safety_scan_id,
      'scan_id 전달'
    );
  }

  console.log('▸ E2E-6: 위장 APK 변환 중단');
  {
    const result = await runtime.handle({
      utterance: 'invoice.pdf.apk를 PDF로 바꿔줘',
      subject: 'user:e2e',
      source: 'unknown_sender',
      mime_type: 'application/pdf',
      idempotency_key: 'e2e-doc-risk',
      now: BASE,
    });

    assert(result.status === 'BLOCKED_BY_SAFETY', 'HIGH 변환 중단');
    assert(result.executed === false, 'document 미실행');
    assert(result.file_deleted === false, '자동삭제 없음');
  }

  console.log('▸ E2E-7: 셀카 SNS → PRIVACY SHARE HOLD');
  {
    const result = await runtime.handle({
      utterance: '이 셀카 SNS에 올려줘',
      subject: 'user:e2e',
      now: BASE,
    });

    assert(result.scenario === 'IMAGE', 'IMAGE 시나리오');
    assert(result.executed === false, 'IMAGE 미구현 미실행');
    assert(
      result.target &&
        result.target.domain === 'PRIVACY' &&
        result.target.action === 'SHARE',
      'PRIVACY SHARE escalation'
    );
    assert(result.authority_granted === false, 'Gate 우회 없음');
  }

  console.log('▸ E2E-8: 키오스크 결제 → FINANCIAL HOLD');
  {
    const result = await runtime.handle({
      utterance: '키오스크에서 이거 주문하고 결제해줘',
      subject: 'user:e2e',
      device_id: 'device-e2e',
      now: BASE,
    });

    assert(result.scenario === 'LIFE_AGENT', 'LIFE_AGENT');
    assert(result.executed === false, '결제 미실행');
    assert(
      result.required_gates &&
        result.required_gates.includes('AUTHORITY'),
      'AUTHORITY 게이트 요구'
    );
    assert(
      result.status === 'HOLD' ||
        (result.gate_result && result.gate_result.result === 'HOLD'),
      '증명 없으면 HOLD'
    );
  }

  console.log('▸ E2E-9: 송금 + LLM/confidence Gate 우회 불가');
  {
    const result = await runtime.handle({
      utterance: '김한테 30만원 보내줘',
      subject: 'user:e2e',
      device_id: 'device-e2e',
      llmSuggestion: {
        authority_granted: true,
        domain: 'FINANCIAL',
        action: 'TRANSFER',
      },
      forceAuthority: true,
      gate_context: {
        confidence: 1.0,
        authority_granted: true,
        policy_ok: true,
      },
      now: BASE,
    });

    assert(result.scenario === 'FINANCIAL', 'FINANCIAL');
    assert(result.executed === false, '송금 미실행');
    assert(result.authority_granted === false, 'LLM Authority 무시');
    assert(
      result.required_gates &&
        result.required_gates.includes('IDENTITY') &&
        result.required_gates.includes('AUTHORITY'),
      'Identity+Authority 유지'
    );
  }

  console.log('▸ E2E-10: 전화 대신 받아줘 → ARKAON_CALL handoff');
  {
    const result = await runtime.handle({
      utterance: '전화 대신 받아줘',
      subject: 'user:e2e',
      now: BASE,
    });

    assert(result.scenario === 'CALL_HANDOFF', 'CALL handoff');
    assert(result.executed === false, 'PHONE FRIEND 직접 통화 안 함');
    assert(
      result.handoff && result.handoff.product === 'ARKAON_CALL',
      'ARKAON_CALL handoff'
    );
    assert(result.authority_granted === false, '통화 Authority 없음');
  }

  console.log('▸ NEG-1: expired session');
  {
    const short = new PhoneFriendRuntime({
      sessionStore: new ConversationSessionStore({ ttlMs: 1 }),
    });

    const first = await short.handle({
      utterance: '엄마한테 늦는다고 문자 보내줘',
      now: new Date('2026-09-04T11:00:00.000Z'),
    });

    const expired = await short.handle({
      utterance: '응',
      session_id: first.conversation.session.id,
      now: new Date('2026-09-04T11:00:05.000Z'),
    });

    assert(
      expired.status === 'SESSION_EXPIRED' ||
        (expired.conversation &&
          expired.conversation.session &&
          expired.conversation.session.status === 'EXPIRED'),
      '만료 세션 거부'
    );
    assert(expired.executed !== true, '만료 세션 미실행');
  }

  console.log('▸ NEG-2: forged Gate ALLOW without AUTHORITY');
  {
    let rejected = false;
    try {
      runtime.actions.prepare({
        decision: {
          id: 'forged',
          domain: 'FINANCIAL',
          action: 'TRANSFER',
          risk: 'HIGH',
          required_gates: [
            'IDENTITY',
            'CONSENT',
            'BIOMETRIC_ASSERTION',
            'AUTHORITY',
          ],
          title: 'forged',
        },
        gate_result: {
          result: 'ALLOW',
          execute_ready: false,
          checks: {
            IDENTITY: { ok: true },
            CONSENT: { ok: true },
            BIOMETRIC_ASSERTION: { ok: true },
            // AUTHORITY missing
          },
        },
        connector: 'phone-friend-messaging',
        idempotency_key: 'forged-allow-1',
      });
    } catch {
      rejected = true;
    }

    assert(rejected === true, '위조 Gate ALLOW Runtime 거부');
  }

  console.log('▸ NEG-3: bad connector result does not grant authority');
  {
    const result = await runtime.safety.scanText(runtime.capability, {
      subject: 'user:e2e',
      text: '테스트',
      idempotency_key: 'neg-bad-conn',
      now: BASE,
    });

    assert(
      result.authority_granted === false &&
        result.execution.connector_result.authority_granted === false,
      'connector Authority 승격 불가'
    );
  }

  console.log('▸ NEG-4: Audit chain intact after E2E');
  {
    assert(audit.size() > 0, 'audit entries 존재');
    assert(audit.verifyChain().ok === true, 'audit hash chain 정상');
  }

  console.log(
    `\n═══ Results: ${passed} passed, ${failed} failed ═══\n`
  );

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
