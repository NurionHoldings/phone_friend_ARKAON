'use strict';

/**
 * ContactService v0.1
 * ─────────────────────────────────────────────────
 * PHONE FRIEND — CONTACT_MAINTENANCE
 *
 * 범위:
 *   CONTACT_READ
 *      ↓
 *   CONTACT_ANALYZE
 *      ↓
 *   CONTACT_PROPOSE
 *
 * 절대 하지 않는 것:
 *   CONTACT_MERGE
 *   CONTACT_DELETE
 *
 * ContactService 자체는 Authority를 만들지 않는다.
 */

const {
  ContactAnalyzer,
  CONTACT_METHOD,
} = require('../contacts/contact-analyzer.cjs');

const {
  CAPABILITY,
  SKILL_ACTION,
} = require('./catalog.cjs');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeMethod(value) {
  const method = String(value || CONTACT_METHOD.DUPLICATES)
    .trim()
    .toUpperCase();

  if (!Object.values(CONTACT_METHOD).includes(method)) {
    throw new Error('invalid contact analysis method');
  }

  return method;
}

class ContactService {
  constructor(opts = {}) {
    this.analyzer = opts.analyzer || new ContactAnalyzer();
  }

  createReadIntent(input = {}) {
    const method = normalizeMethod(input.method);

    return clone({
      product: 'PHONE_FRIEND',

      /**
       * CONTACT catalog 축 — MERGE/DELETE는 카탈로그/구현 모두 제외.
       */
      product_capability: CAPABILITY.CONTACT,

      capability: SKILL_ACTION.CONTACT_READ,

      domain: 'PRIVACY',

      action: 'READ',

      title: '연락처 읽기 및 정리 후보 분석',

      raw_text: input.raw_text || '연락처 정리 후보를 찾아줘',

      slots: {
        method,

        /**
         * 읽기/분석 전용.
         */
        mutate: false,
      },

      authority_granted: false,
    });
  }

  async read(runtime, input = {}) {
    if (!runtime || typeof runtime.executeIntent !== 'function') {
      throw new Error('capability runtime is required');
    }

    const method = normalizeMethod(input.method);

    /**
     * PRIVACY READ is MEDIUM → POLICY gate.
     * Android OS READ_CONTACTS approval (permission_ok)
     * also satisfies product policy_ok for this READ path.
     */
    const permissionOk =
      input.permission_ok === true ||
      Boolean(input.gate_context && input.gate_context.permission_ok);

    const policyOk =
      input.policy_ok === true ||
      Boolean(input.gate_context && input.gate_context.policy_ok) ||
      permissionOk;

    const result = await runtime.executeIntent({
      intent: this.createReadIntent({
        ...input,
        method,
      }),

      subject: input.subject,

      device_id: input.device_id,

      connector: input.connector || 'phone-friend-contact',

      idempotency_key:
        input.idempotency_key ||
        `contact-read:${input.subject || 'anon'}:${method}`,

      gate_context: {
        ...(input.gate_context || {}),

        /**
         * Android에서는 실제 OS permission 결과를
         * 이 context에 연결할 수 있다.
         */
        permission_ok: permissionOk,
        policy_ok: policyOk,
      },

      retry_safe: true,

      max_retries: 1,

      reversible: true,

      verify_required: true,

      now: input.now,
    });

    return clone(result);
  }

  async analyze(runtime, input = {}) {
    const method = normalizeMethod(input.method);

    const readResult = await this.read(runtime, {
      ...input,
      method,
    });

    /**
     * Gate HOLD/DENY면 분석하지 않는다.
     */
    if (!readResult || readResult.executed !== true) {
      return clone({
        status:
          readResult && readResult.status ? readResult.status : 'HOLD',

        executed: false,

        analyzed: false,

        method,

        read_result: readResult,

        authority_granted: false,
      });
    }

    const contacts =
      readResult.execution &&
      readResult.execution.connector_result &&
      Array.isArray(readResult.execution.connector_result.contacts)
        ? readResult.execution.connector_result.contacts
        : [];

    const analysis = this.analyzer.analyze(contacts, {
      method,
      now: input.now,
    });

    return clone({
      status: 'ANALYZED',

      executed: true,

      analyzed: true,

      method,

      read_result: readResult,

      analysis,

      /**
       * 분석은 현실 상태를 변경하지 않는다.
       */
      mutated: false,

      authority_granted: false,
    });
  }

  async propose(runtime, input = {}) {
    const analyzed = await this.analyze(runtime, input);

    if (analyzed.analyzed !== true) {
      return clone({
        ...analyzed,

        proposed: false,

        proposals: [],
      });
    }

    const proposals = this.analyzer.propose(analyzed.analysis, {
      limit: input.limit,
    });

    return clone({
      ...analyzed,

      status: 'PROPOSED',

      proposed: true,

      proposals,

      /**
       * 매우 중요:
       * 제안은 MERGE/DELETE 명령이 아니다.
       */
      merge_executed: false,

      delete_executed: false,

      mutated: false,

      authority_granted: false,
    });
  }

  merge() {
    throw new Error('CONTACT_MERGE is not implemented in v0.1');
  }

  delete() {
    throw new Error('CONTACT_DELETE is not implemented in v0.1');
  }
}

module.exports = {
  ContactService,
  normalizeMethod,
};
