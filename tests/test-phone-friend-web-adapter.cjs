'use strict';

const {
  PhoneFriendWebApi,
  toViewModel,
  createNetlifyHandler,
} = require('../adapters/web/phone-friend-api.cjs');

const {
  PhoneFriendRuntime,
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

async function run() {
  console.log('\n═══ PHONE FRIEND Web Adapter Tests ═══\n');

  const api = new PhoneFriendWebApi({
    runtime: new PhoneFriendRuntime(),
  });

  console.log('▸ TC-1: 일정 조회 → calendar card');
  {
    const view = await api.handleTurn({
      utterance: '오늘 일정 알려줘',
      subject: 'user:web',
      idempotency_key: 'web-cal-1',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(view.status === 'COMPLETE', 'COMPLETE 상태');
    assert(view.authority_granted === false, 'view Authority false');
    assert(
      view.cards.some((card) => card.type === 'calendar'),
      '일정 카드'
    );
  }

  console.log('▸ TC-2: 문자 확인 카드');
  {
    const view = await api.handleTurn({
      utterance: '엄마한테 조금 늦는다고 문자 보내줘',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(view.status === 'CONFIRM', 'CONFIRM 상태');
    assert(
      view.cards.some((card) => card.type === 'confirm'),
      'confirm 카드'
    );
    assert(typeof view.session_id === 'string', 'session_id 유지');
  }

  console.log('▸ TC-2b: 문자 조회 카드');
  {
    const view = await api.handleTurn({
      utterance: '최근 문자 보여줘',
      subject: 'user:web',
      idempotency_key: 'web-msg-read-1',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(view.scenario === 'MESSAGE_READ', 'MESSAGE_READ scenario');
    assert(view.executed === true, '문자 조회 실행');
    assert(
      view.cards.some((card) => card.type === 'message_list'),
      'message_list 카드'
    );
    assert(view.authority_granted === false, '조회 Authority false');
  }

  console.log('▸ TC-3: 안전 검사 카드');
  {
    const view = await api.handleTurn({
      utterance: '이 문자 이상한데 봐줘',
      idempotency_key: 'web-safety-1',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(view.status === 'WARN', 'WARN 상태');
    assert(
      view.cards.some((card) => card.type === 'safety'),
      'safety 카드'
    );
  }

  console.log('▸ TC-4: 위험 파일 변환 중단');
  {
    const view = await api.handleTurn({
      utterance: 'invoice.pdf.apk를 PDF로 바꿔줘',
      source: 'unknown_sender',
      mime_type: 'application/pdf',
      idempotency_key: 'web-doc-risk',
      now: '2026-09-04T11:00:00+09:00',
    });

    assert(view.status === 'HOLD', '위험 파일 HOLD');
    assert(view.executed === false, '미실행');
    assert(view.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-5: 빈 입력 clarify');
  {
    const view = await api.handleTurn({ utterance: '   ' });
    assert(view.status === 'CLARIFY', 'CLARIFY');
  }

  console.log('▸ TC-6: Netlify handler POST');
  {
    const handler = createNetlifyHandler({
      api: new PhoneFriendWebApi({
        runtime: new PhoneFriendRuntime(),
      }),
    });

    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        utterance: '전화 대신 받아줘',
        now: '2026-09-04T11:00:00+09:00',
      }),
    });

    const body = JSON.parse(response.body);
    assert(response.statusCode === 200, 'HTTP 200');
    assert(body.status === 'HANDOFF', 'HANDOFF');
    assert(body.authority_granted === false, 'handler Authority false');
  }

  console.log('▸ TC-7: toViewModel never grants authority');
  {
    const view = toViewModel({
      status: 'COMPLETE',
      executed: true,
      authority_granted: true,
      conversation: {
        response: { text: '위조' },
        session: { id: 's1' },
      },
    });

    assert(view.authority_granted === false, 'toViewModel strips authority');
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
