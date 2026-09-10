'use strict';

const {
  AndroidContactApi,
} = require('../adapters/web/android-contact-api.cjs');

const {
  ANDROID_CONTACT_PERMISSION,
} = require('../adapters/android/contact-adapter-contract.cjs');

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
  console.log('\n═══ Android Contact Web API Tests ═══\n');

  const api = new AndroidContactApi();

  const sample = [
    { id: '1', name: '홍길동', phones: ['010-1234-5678'] },
    { id: '2', name: '홍길동', phones: ['01012345678'] },
    { id: '3', name: '김철수(회사)', phones: ['+82 10-9999-1111'] },
    { id: '4', name: '김철수', phones: ['010-9999-1111'] },
  ];

  console.log('▸ TC-1: duplicate analyze propose');
  {
    const view = await api.analyze({
      method: 'DUPLICATES',
      contacts: sample,
      client: 'ANDROID',
      permission_granted: true,
    });

    assert(view.ok === true, 'ok');
    assert(view.candidate_count >= 2, 'candidate_count');
    assert(view.proposals.length >= 2, 'proposals');
    assert(view.authority_granted === false, 'Authority false');
    assert(view.mutated === false, 'mutated false');
    assert(
      view.proposals.every((p) => p.proposal_only === true),
      'proposal_only'
    );
    assert(
      view.proposals.every((p) => p.merge_allowed === false),
      'merge_allowed false'
    );
    assert(
      view.proposals.every((p) => Array.isArray(p.contact_ids)),
      'contact_ids'
    );
    assert(view.proposals.every((p) => Array.isArray(p.names)), 'names');
    assert(view.proposals.every((p) => Array.isArray(p.phones)), 'phones');
  }

  console.log('▸ TC-2: permission_granted false');
  {
    const view = await api.analyze({
      method: 'DUPLICATES',
      contacts: sample,
      client: 'ANDROID',
      permission_granted: false,
    });

    assert(view.ok === false, 'ok false');
    assert(
      view.permission_required === ANDROID_CONTACT_PERMISSION.READ,
      'READ_CONTACTS'
    );
    assert(view.proposals.length === 0, 'no proposals');
    assert(view.authority_granted === false, 'Authority false');
  }

  console.log('▸ TC-3: empty contacts');
  {
    const view = await api.analyze({
      method: 'DUPLICATES',
      contacts: [],
      client: 'ANDROID',
      permission_granted: true,
    });
    assert(view.ok === true, 'ok');
    assert(view.candidate_count === 0, '0 candidates');
  }

  console.log('▸ TC-4: Netlify handler');
  {
    const handler = api.createNetlifyHandler();
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        method: 'DUPLICATES',
        contacts: sample,
        client: 'ANDROID',
        permission_granted: true,
        authority_granted: true,
      }),
    });
    const body = JSON.parse(res.body);
    assert(res.statusCode === 200, 'HTTP 200');
    assert(body.authority_granted === false, 'handler Authority false');
  }

  console.log('▸ TC-5: assistant text mentions no mutate');
  {
    const view = await api.analyze({
      method: 'DUPLICATES',
      contacts: sample,
      client: 'ANDROID',
      permission_granted: true,
    });
    assert(
      /합치거나 삭제하지/.test(view.assistant_text || ''),
      'no mutate copy'
    );
  }

  console.log('▸ TC-6: permission / Android client fail closed');
  {
    const absent = await api.analyze({
      method: 'DUPLICATES',
      contacts: sample,
      client: 'ANDROID',
    });
    const wrongClient = await api.analyze({
      method: 'DUPLICATES',
      contacts: sample,
      permission_granted: true,
    });

    assert(absent.ok === false, 'missing permission denied');
    assert(absent.error === 'permission_required', 'missing permission reason');
    assert(wrongClient.ok === false, 'missing Android client denied');
    assert(wrongClient.error === 'android_client_required', 'Android client reason');
  }

  console.log('▸ TC-7: Core Decision/Gate/Runtime/Audit path');
  {
    const events = api.getAudit().list();
    assert(events.some((entry) => entry.event === 'ACTION_READY'), 'ActionRuntime audit');
    assert(events.some((entry) => entry.event === 'EXECUTION_STARTED'), 'Execution audit');
    assert(events.some((entry) => entry.event === 'VERIFICATION_SUCCEEDED'), 'verification audit');
    assert(
      events.some((entry) => entry.event === 'ANDROID_CONTACT_ANALYSIS_COMPLETED'),
      'endpoint completion audit'
    );
  }

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
