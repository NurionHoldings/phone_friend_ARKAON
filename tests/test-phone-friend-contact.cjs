'use strict';

const {
  DecisionEngine,
} = require('../core/decision-engine.cjs');

const {
  GateEngine,
} = require('../core/gate-engine.cjs');

const {
  ActionRuntime,
} = require('../core/action-runtime.cjs');

const {
  AuditEngine,
} = require('../core/audit-engine.cjs');

const {
  ExecutionEngine,
} = require('../core/execution-engine.cjs');

const {
  CapabilityRuntime,
} = require('../products/phone-friend/runtime/capability-runtime.cjs');

const {
  ContactService,
} = require('../products/phone-friend/capabilities/contact-service.cjs');

const {
  CAPABILITY,
  SKILL_ACTION,
  resolveProductCapability,
} = require('../products/phone-friend/capabilities/catalog.cjs');

const {
  ContactAnalyzer,
  CONTACT_METHOD,
  normalizePhone,
  normalizeName,
  nameSimilarity,
  duplicateScore,
} = require('../products/phone-friend/contacts/contact-analyzer.cjs');

const {
  MemoryContactConnector,
} = require('../connectors/phone-friend/memory-contact-connector.cjs');

const {
  AndroidContactAdapterContract,
  ANDROID_CONTACT_PERMISSION,
  sanitizeAndroidContact,
} = require('../adapters/android/contact-adapter-contract.cjs');

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

async function run() {
  console.log(
    '\n═══ PHONE FRIEND Android CONTACT Capability v0.1 Tests ═══\n'
  );

  const analyzer = new ContactAnalyzer();
  const connector = new MemoryContactConnector();
  const audit = new AuditEngine();
  const actions = new ActionRuntime({
    auditEngine: audit,
  });

  const executions = new ExecutionEngine({
    actionRuntime: actions,
    auditEngine: audit,
    connectors: {
      'phone-friend-contact': connector,
    },
  });

  const capability = new CapabilityRuntime({
    decisionEngine: new DecisionEngine(),
    gateEngine: new GateEngine(),
    actionRuntime: actions,
    executionEngine: executions,
  });

  const contacts = new ContactService({
    analyzer,
  });

  console.log('▸ TC-1: 전화번호 정규화');
  {
    assert(
      normalizePhone('010-1234-5678') === '01012345678',
      '하이픈 제거'
    );
    assert(
      normalizePhone('+82 10-1234-5678') === '01012345678',
      '+82 → 국내 0 prefix'
    );
  }

  console.log('▸ TC-2: 이름 정규화');
  {
    assert(
      normalizeName('김철수(회사)') === normalizeName('김철수'),
      '회사 suffix 제거'
    );
  }

  console.log('▸ TC-3: 이름 유사도');
  {
    assert(nameSimilarity('박영희', '박영이') > 0.6, '유사 이름 탐지');
    assert(nameSimilarity('홍길동', '홍길동') === 1, '동일 이름 1.0');
  }

  console.log('▸ TC-4: 동일 번호 duplicate score');
  {
    const result = duplicateScore(
      {
        id: 'a',
        name: '홍길동',
        phones: ['010-1234-5678'],
      },
      {
        id: 'b',
        name: '홍길동',
        phones: ['01012345678'],
      }
    );

    assert(result.score >= 0.9, '동일 번호+이름 HIGH');
    assert(
      result.common_phones.includes('01012345678'),
      '정규화 공통번호 provenance'
    );
  }

  console.log('▸ TC-5: analyzer duplicate');
  {
    const analysis = analyzer.analyze(connector.list(), {
      method: CONTACT_METHOD.DUPLICATES,
    });

    assert(
      analysis.method === CONTACT_METHOD.DUPLICATES,
      'DUPLICATES method'
    );
    assert(analysis.candidate_count >= 2, '중복 후보 탐지');
    assert(
      analysis.candidates.every((item) => item.mutate === false),
      '분석 후보 mutate false'
    );
  }

  console.log('▸ TC-6: 이름 없는 연락처');
  {
    const analysis = analyzer.analyze(connector.list(), {
      method: CONTACT_METHOD.NO_NAME,
    });

    assert(analysis.candidate_count === 1, '이름 없는 연락처 1개');
    assert(
      analysis.candidates[0].type === 'NO_NAME_CANDIDATE',
      'NO_NAME type'
    );
  }

  console.log('▸ TC-7: 오래된 연락처');
  {
    const analysis = analyzer.analyze(connector.list(), {
      method: CONTACT_METHOD.INACTIVE,
      now: '2026-09-04T15:00:00+09:00',
      inactive_days: 365,
    });

    assert(analysis.candidate_count >= 1, 'inactive 후보 탐지');
  }

  console.log('▸ TC-8: Analyzer 원본 불변');
  {
    const source = connector.list();
    const before = JSON.stringify(source);

    analyzer.analyze(source, {
      method: CONTACT_METHOD.DUPLICATES,
    });

    assert(
      JSON.stringify(source) === before,
      '분석 후 원본 연락처 불변'
    );
  }

  console.log('▸ TC-9: CONTACT_READ intent');
  {
    const intent = contacts.createReadIntent({
      method: CONTACT_METHOD.DUPLICATES,
    });

    assert(intent.capability === SKILL_ACTION.CONTACT_READ, 'CONTACT_READ capability');
    assert(
      intent.product_capability === CAPABILITY.CONTACT,
      'CONTACT product capability'
    );
    assert(
      resolveProductCapability(SKILL_ACTION.CONTACT_READ) ===
        CAPABILITY.CONTACT,
      'catalog CONTACT 매핑'
    );
    assert(intent.domain === 'PRIVACY', 'PRIVACY domain');
    assert(intent.action === 'READ', 'READ action');
    assert(intent.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-10: Memory connector READ');
  {
    const result = await connector.execute({
      skill: 'CONTACT_READ',
      payload: {
        mutate: false,
      },
    });

    assert(result.ok === true, 'CONTACT_READ 성공');
    assert(result.contacts.length >= 6, 'contact snapshot 반환');
    assert(result.mutation_performed === false, '현실 변경 없음');
  }

  console.log('▸ TC-11: Connector mutation skill 거부');
  {
    const result = await connector.execute({
      skill: 'CONTACT_DELETE',
      payload: {
        id: 'contact-1',
      },
    });

    assert(result.ok === false, 'CONTACT_DELETE 거부');
    assert(connector.mutation_count === 0, 'mutation count 0');
  }

  console.log('▸ TC-12: CONTACT_READ mutate=true 거부');
  {
    const result = await connector.execute({
      skill: 'CONTACT_READ',
      payload: {
        mutate: true,
      },
    });

    assert(result.ok === false, 'READ에서 mutation 요청 거부');
  }

  console.log('▸ TC-13: Service READ → ANALYZE → PROPOSE');
  {
    const result = await contacts.propose(capability, {
      subject: 'user:1',
      device_id: 'device:1',
      method: CONTACT_METHOD.DUPLICATES,
      permission_ok: true,
      /**
       * 현재 Gate 구현에서 READ가 AUTO라면
       * permission_ok는 Android adapter contract용 provenance.
       */
      idempotency_key: 'contact-propose-1',
      now: '2026-09-04T15:00:00+09:00',
    });

    assert(result.proposed === true, 'proposal 생성');
    assert(result.analysis.candidate_count > 0, 'analysis candidate 존재');
    assert(result.proposals.length > 0, 'proposal list 존재');
    assert(result.merge_executed === false, 'merge 미실행');
    assert(result.delete_executed === false, 'delete 미실행');
  }

  console.log('▸ TC-14: Proposal은 실행 허가 아님');
  {
    const analysis = analyzer.analyze(connector.list(), {
      method: CONTACT_METHOD.DUPLICATES,
    });

    const proposals = analyzer.propose(analysis);

    assert(
      proposals.every((proposal) => proposal.proposal_only === true),
      'proposal_only'
    );
    assert(
      proposals.every((proposal) => proposal.merge_allowed === false),
      'merge_allowed false'
    );
    assert(
      proposals.every((proposal) => proposal.delete_allowed === false),
      'delete_allowed false'
    );
  }

  console.log('▸ TC-15: ContactService MERGE/DELETE 미구현');
  {
    assertThrows(() => contacts.merge(), 'MERGE 차단');
    assertThrows(() => contacts.delete(), 'DELETE 차단');
  }

  console.log('▸ TC-16: Android adapter permission contract');
  {
    const adapter = new AndroidContactAdapterContract();
    const permissions = adapter.getRequiredPermissions();

    assert(permissions.length === 1, 'v0.1 permission 1개');
    assert(
      permissions[0] === ANDROID_CONTACT_PERMISSION.READ,
      'READ_CONTACTS만 요구'
    );
    assert(
      !permissions.includes('android.permission.WRITE_CONTACTS'),
      'WRITE_CONTACTS 미요구'
    );
  }

  console.log('▸ TC-17: Android contact sanitizer');
  {
    const sanitized = sanitizeAndroidContact({
      id: 10,
      display_name: '테스트',
      phones: ['010-1111-2222'],
    });

    assert(sanitized.id === '10', 'id string normalize');
    assert(sanitized.read_only === true, 'read_only true');
  }

  console.log('▸ TC-18: Android adapter permission deny');
  {
    class TestAdapter extends AndroidContactAdapterContract {
      async hasReadPermission() {
        return false;
      }

      async readContacts() {
        throw new Error('should not be called');
      }
    }

    const adapter = new TestAdapter();
    const result = await adapter.executeRead();

    assert(result.ok === false, 'permission deny');
    assert(
      result.permission_required === ANDROID_CONTACT_PERMISSION.READ,
      'READ_CONTACTS 안내'
    );
    assert(
      result.mutation_performed === false,
      'permission deny에서도 mutation 없음'
    );
  }

  console.log('▸ TC-19: Android adapter READ');
  {
    class TestAdapter extends AndroidContactAdapterContract {
      async hasReadPermission() {
        return true;
      }

      async readContacts() {
        return [
          {
            id: 1,
            name: '홍길동',
            phones: ['010-1234-5678'],
          },
        ];
      }
    }

    const adapter = new TestAdapter();
    const result = await adapter.executeRead();

    assert(result.ok === true, 'Android READ 성공');
    assert(result.contacts.length === 1, 'Android contact 반환');
    assert(result.authority_granted === false, 'Android adapter Authority false');
  }

  console.log('▸ TC-20: Android MERGE/DELETE 금지');
  {
    const adapter = new AndroidContactAdapterContract();

    assertThrows(() => adapter.mergeContacts(), 'Android MERGE 금지');
    assertThrows(() => adapter.deleteContact(), 'Android DELETE 금지');
  }

  console.log('▸ TC-21: PhoneFriendRuntime natural CONTACT 연결');
  {
    const runtime = new PhoneFriendRuntime({
      contact: {
        contacts: connector.list(),
      },
    });

    const first = await runtime.handle({
      utterance: '내 폰의 연락처를 정리해줘',
      subject: 'user:contact-e2e',
      device_id: 'device:contact-e2e',
      permission_ok: true,
      now: '2026-09-04T15:00:00+09:00',
    });

    assert(
      first.scenario === 'NATURAL_CONTACT_MAINTENANCE',
      '첫 turn CONTACT natural'
    );
    assert(first.executed === false, '첫 turn 실행 없음');

    const second = await runtime.handle({
      utterance: '중복된 것부터',
      subject: 'user:contact-e2e',
      device_id: 'device:contact-e2e',
      natural_session_id: first.natural_session_id,
      permission_ok: true,
      now: '2026-09-04T15:01:00+09:00',
    });

    assert(
      second.scenario === 'CONTACT_MAINTENANCE',
      '두 번째 turn 실제 contact path'
    );
    assert(Array.isArray(second.proposals), 'proposals 반환');
    assert(second.mutated === false, 'Runtime에서도 mutation 없음');
    assert(
      second.authority_granted === false,
      'Runtime contact Authority false'
    );
  }

  console.log('▸ TC-22: Progress narration');
  {
    const runtime = new PhoneFriendRuntime();

    const first = await runtime.handle({
      utterance: '연락처 정리하자',
      subject: 'user:progress',
      permission_ok: true,
    });

    const second = await runtime.handle({
      utterance: '중복 번호부터',
      subject: 'user:progress',
      natural_session_id: first.natural_session_id,
      permission_ok: true,
    });

    assert(Array.isArray(second.progress), 'progress array');
    assert(
      second.progress.some((step) =>
        /비교|분석/.test(String(step.text || ''))
      ),
      '분석 진행 설명'
    );
    assert(
      second.progress.some((step) =>
        /변경하지|합치거나|삭제/.test(String(step.text || ''))
      ),
      '변경 안 함 안내'
    );
  }

  console.log('▸ TC-23: Memory connector defensive copy');
  {
    const list = connector.list();
    list[0].name = '악의적 수정';
    const again = connector.list();
    assert(again[0].name !== '악의적 수정', 'connector defensive copy');
  }

  console.log('▸ TC-24: Analysis defensive copy');
  {
    const source = connector.list();
    const result = analyzer.analyze(source, {
      method: CONTACT_METHOD.DUPLICATES,
    });

    if (result.candidates.length > 0) {
      result.candidates[0].contacts[0].name = '오염';
    }

    const fresh = connector.list();
    assert(
      !fresh.some((contact) => contact.name === '오염'),
      'analysis가 원본 connector 상태 오염 안 함'
    );
  }

  console.log('▸ TC-25: Audit chain 유지');
  {
    assert(audit.verifyChain().ok === true, 'audit chain 정상');
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
