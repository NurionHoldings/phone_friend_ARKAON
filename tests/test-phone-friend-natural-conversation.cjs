'use strict';

/**
 * PHONE FRIEND — Natural Conversation + Progress Narration v0.1
 */

const {
  PhoneFriendRuntime,
} = require('../products/phone-friend/runtime/phone-friend-runtime.cjs');

const {
  PhoneFriendWebApi,
} = require('../adapters/web/phone-friend-api.cjs');

const {
  NaturalConversationEngine,
  NATURAL_GOAL,
} = require('../products/phone-friend/natural/natural-conversation-engine.cjs');

const {
  PLAN_STATUS,
  RISK_BOUNDARY,
} = require('../products/phone-friend/natural/dialogue-plan.cjs');

const {
  PROGRESS_STAGE,
} = require('../products/phone-friend/progress/progress-narrator.cjs');

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

async function run() {
  console.log('\n═══ PHONE FRIEND Natural Conversation Tests ═══\n');

  const engine = new NaturalConversationEngine();
  const runtime = new PhoneFriendRuntime();
  const api = new PhoneFriendWebApi({ runtime });

  console.log('▸ TC-1: 연락처 정리 → clarify (generic 응답 금지)');
  {
    const view = await api.handleTurn({
      utterance: '내 폰의 연락처를 정리해줘',
      natural_session_id: 'nat-contact-1',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(
      !/요청하신 내용을 확인했습니다/.test(view.assistant_text || ''),
      'generic 응답 없음'
    );
    assert(
      /후보|중복|이름 없는|오래/.test(view.assistant_text || ''),
      '정리 방식 되묻기'
    );
    assert(view.authority_granted === false, 'Authority false');
    assert(
      Array.isArray(view.progress) && view.progress.length >= 2,
      'progress steps 누적'
    );
    assert(
      view.progress.some((p) => p.stage === PROGRESS_STAGE.UNDERSTANDING),
      'UNDERSTANDING 단계'
    );
  }

  console.log('▸ TC-2: 중복부터 → READ/ANALYZE plan (실행/변경 없음)');
  {
    const r1 = await runtime.handle({
      utterance: '연락처 좀 정리하자',
      natural_session_id: 'nat-contact-2',
      subject: 'user:test',
      now: '2026-09-04T11:00:00+09:00',
    });
    const r2 = await runtime.handle({
      utterance: '중복된 것부터',
      natural_session_id: 'nat-contact-2',
      subject: 'user:test',
      now: '2026-09-04T11:00:01+09:00',
    });

    assert(r1.executed === false, '1턴 미실행');
    assert(r2.executed === false, '2턴 미실행');
    assert(r2.authority_granted === false, '2턴 Authority false');
    assert(
      /합치거나 삭제하지/.test(r2.assistant_text || ''),
      '변경하지 않음 안내'
    );
    assert(
      r2.dialogue_plan &&
        r2.dialogue_plan.mutate === false &&
        r2.dialogue_plan.risk_boundary === RISK_BOUNDARY.ANALYZE,
      'READ/ANALYZE 경계'
    );
    assert(
      r2.dialogue_plan.capability_candidates.includes('CONTACT_READ'),
      'CONTACT_READ 후보만'
    );
    assert(
      r2.progress.some(
        (p) => p.stage === PROGRESS_STAGE.CHECKING_PERMISSION
      ),
      '권한 확인 progress'
    );
    assert(
      r2.progress.some((p) => /변경하지/.test(p.text || '')),
      '변경 보류 progress'
    );
  }

  console.log('▸ TC-3: 진행과정 피드백');
  {
    const view = await api.handleTurn({
      utterance: '진행과정은 말해줘야지...',
      natural_session_id: 'nat-progress-1',
    });
    assert(
      !/요청하신 내용을 확인했습니다/.test(view.assistant_text || ''),
      'generic 응답 없음'
    );
    assert(/진행|말하고|확인/.test(view.assistant_text || ''), '진행 안내 약속');
    assert(view.presence_label, 'presence_label 제공');
  }

  console.log('▸ TC-4: paraphrase → MESSAGE_SEND');
  {
    const interpreted = engine.interpret({
      utterance: '엄마한테 나 늦는다고 좀 알려줘',
    });
    assert(interpreted.handled === true, 'MESSAGE paraphrase handled');
    assert(interpreted.goal === NATURAL_GOAL.MESSAGE_SEND, 'MESSAGE_SEND goal');
    assert(interpreted.authority_granted === false, 'NLP Authority false');

    const view = await api.handleTurn({
      utterance: '엄마한테 나 늦는다고 좀 알려줘',
      natural_session_id: 'nat-msg-1',
      now: '2026-09-04T11:00:00+09:00',
    });
    assert(view.status === 'CONFIRM', 'CONFIRM 상태');
    assert(view.authority_granted === false, 'view Authority false');
  }

  console.log('▸ TC-4b: paraphrase → MESSAGE_READ');
  {
    const api = new PhoneFriendWebApi({
      runtime: new PhoneFriendRuntime(),
    });
    const view = await api.handleTurn({
      utterance: '엄마 문자 확인해줘',
      subject: 'user:nat',
      idempotency_key: 'nat-msg-read-1',
      now: '2026-09-04T11:00:00+09:00',
    });
    assert(view.scenario === 'MESSAGE_READ', 'MESSAGE_READ scenario');
    assert(view.executed === true, 'MESSAGE_READ executed');
    assert(view.authority_granted === false, 'MESSAGE_READ Authority false');
    assert(
      view.cards.some((card) => card.type === 'message_list'),
      'message_list 카드'
    );
  }

  console.log('▸ TC-5: paraphrase → CALENDAR_READ');
  {
    const interpreted = engine.interpret({
      utterance: '오늘 뭐 있지?',
    });
    assert(interpreted.goal === NATURAL_GOAL.CALENDAR_READ, 'CALENDAR goal');

    const view = await api.handleTurn({
      utterance: '오늘 뭐 있지?',
      natural_session_id: 'nat-cal-1',
      idempotency_key: 'nat-cal-read-1',
      now: '2026-09-04T11:00:00+09:00',
    });
    assert(view.scenario === 'CALENDAR_READ', 'CALENDAR_READ scenario');
    assert(view.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-6: paraphrase → SAFETY_TEXT');
  {
    const interpreted = engine.interpret({
      utterance: '이거 피싱 아니야?',
    });
    assert(interpreted.goal === NATURAL_GOAL.SAFETY_TEXT, 'SAFETY goal');

    const view = await api.handleTurn({
      utterance: '이거 이상한 문자 같은데',
      natural_session_id: 'nat-safe-1',
      idempotency_key: 'nat-safe-1',
      now: '2026-09-04T11:00:00+09:00',
    });
    assert(view.status === 'WARN', 'WARN 상태');
    assert(view.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-7: DOCUMENT_SIMPLIFY — plan only');
  {
    const r = await runtime.handle({
      utterance: '이 문서가 무슨 말이야?',
      natural_session_id: 'nat-doc-1',
    });
    assert(r.executed === false, '문서 단순화 미실행');
    assert(
      r.dialogue_plan &&
        r.dialogue_plan.status === PLAN_STATUS.CLARIFY &&
        r.dialogue_plan.mutate === false,
      'clarify plan / no mutate'
    );
    assert(r.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-8: Natural layer cannot grant authority');
  {
    const interpreted = engine.interpret({
      utterance: '내 폰의 연락처를 정리해줘',
    });
    assert(interpreted.authority_granted === false, 'interpret Authority false');
    assert(
      interpreted.dialogue_plan.authority_granted === false,
      'plan Authority false'
    );
    assert(interpreted.execute == null, 'CONTACT execute null in v0.1');
  }

  console.log(
    `\n결과: ${passed} passed, ${failed} failed\n`
  );
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
