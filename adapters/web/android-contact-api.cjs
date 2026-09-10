'use strict';

/**
 * Android Contact Web Adapter v0.1
 * ─────────────────────────────────────────────────
 * Device Bridge dedicated endpoint.
 *
 * Android already performed READ_CONTACTS and explicitly reports that result.
 * This adapter:
 *   - accepts an ephemeral contact snapshot only after permission=true
 *   - routes CONTACT_READ through Core Decision → Gate → Runtime → Audit
 *   - returns CONTACT_PROPOSE candidates
 *   - does NOT persist address books
 *   - does NOT merge/delete
 *   - never grants Authority
 */

const {
  ContactAnalyzer,
  CONTACT_METHOD,
} = require('../../products/phone-friend/contacts/contact-analyzer.cjs');

const { DecisionEngine } = require('../../core/decision-engine.cjs');
const { GateEngine } = require('../../core/gate-engine.cjs');
const { ActionRuntime } = require('../../core/action-runtime.cjs');
const { ExecutionEngine } = require('../../core/execution-engine.cjs');
const { AuditEngine } = require('../../core/audit-engine.cjs');
const {
  CapabilityRuntime,
} = require('../../products/phone-friend/runtime/capability-runtime.cjs');
const {
  ContactService,
} = require('../../products/phone-friend/capabilities/contact-service.cjs');

const {
  sanitizeAndroidContact,
  ANDROID_CONTACT_PERMISSION,
} = require('../android/contact-adapter-contract.cjs');

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

function sanitizeSnapshot(contacts) {
  if (!Array.isArray(contacts)) {
    throw new Error('contacts must be an array');
  }

  return contacts.map((item) => {
    const sanitized = sanitizeAndroidContact({
      id: item.id,
      name: item.name || item.display_name || '',
      display_name: item.display_name || item.name || '',
      phones: Array.isArray(item.phones) ? item.phones : [],
    });

    /**
     * Minimal fields only for analyze path.
     */
    return {
      id: sanitized.id,
      name: sanitized.name,
      phones: sanitized.phones,
    };
  });
}

function mapProposal(candidate) {
  const contacts = Array.isArray(candidate.contacts)
    ? candidate.contacts
    : candidate.contact
      ? [candidate.contact]
      : [];

  const names = contacts
    .map((c) => String((c && (c.name || c.display_name)) || '').trim())
    .filter((name, index, list) => list.indexOf(name) === index);

  const phones = Array.isArray(candidate.common_phones)
    ? [...candidate.common_phones]
    : contacts
        .flatMap((c) => (Array.isArray(c.phones) ? c.phones : []))
        .map((p) => String(p || '').trim())
        .filter(Boolean);

  return clone({
    id: candidate.id,
    type: candidate.type || 'DUPLICATE_CANDIDATE',
    contact_ids: Array.isArray(candidate.contact_ids)
      ? [...candidate.contact_ids]
      : contacts.map((c) => String(c.id)),
    names,
    phones: [...new Set(phones)],
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    level: candidate.level || 'LOW',
    proposal_only: true,
    merge_allowed: false,
    delete_allowed: false,
    authority_granted: false,
  });
}

class AndroidContactApi {
  constructor(opts = {}) {
    this.analyzer = opts.analyzer || new ContactAnalyzer();
    this.audit = opts.auditEngine || new AuditEngine();
  }

  getAudit() {
    return this.audit;
  }

  _permissionDenied(method, error = 'permission_required') {
    this.audit.append({
      event: 'ANDROID_CONTACT_READ_DENIED',
      data: {
        method,
        reason: error,
        resource_id: 'android-contact-snapshot',
      },
    });

    return clone({
      ok: false,
      method,
      candidate_count: 0,
      proposals: [],
      mutated: false,
      authority_granted: false,
      permission_required: ANDROID_CONTACT_PERMISSION.READ,
      error,
      assistant_text:
        '연락처를 읽으려면 권한이 필요해요. 읽기만 하고 수정하거나 삭제하지 않을게요.',
    });
  }

  _coreForSnapshot(snapshot) {
    const decisions = new DecisionEngine();
    const gates = new GateEngine();
    const actions = new ActionRuntime({ auditEngine: this.audit });

    const connector = {
      async execute(action) {
        if (!action || action.skill !== 'CONTACT_READ') {
          return { ok: false, error: 'contact_read_only' };
        }

        return {
          ok: true,
          contacts: clone(snapshot),
          count: snapshot.length,
          permission: 'READ_ONLY',
          mutation_performed: false,
          authority_granted: false,
        };
      },

      async verify(action, result) {
        return {
          ok: Boolean(
            action &&
              action.skill === 'CONTACT_READ' &&
              result &&
              Array.isArray(result.contacts) &&
              result.mutation_performed === false
          ),
          verified: 'android_contact_read_completed',
          mutation_verified: false,
          authority_granted: false,
        };
      },
    };

    const executions = new ExecutionEngine({
      actionRuntime: actions,
      auditEngine: this.audit,
      connectors: { 'android-contact-snapshot': connector },
    });

    return {
      capability: new CapabilityRuntime({
        decisionEngine: decisions,
        gateEngine: gates,
        actionRuntime: actions,
        executionEngine: executions,
      }),
      contacts: new ContactService({ analyzer: this.analyzer }),
    };
  }

  async analyze(input = {}) {
    const method = normalizeMethod(input.method);

    /**
     * Fail closed.  An absent value is not an Android OS grant.  Android
     * client and permission flag are both explicit so a browser payload cannot
     * silently become a device-contact read request.
     */
    if (input.client !== 'ANDROID') {
      return this._permissionDenied(method, 'android_client_required');
    }

    if (input.permission_granted !== true) {
      return this._permissionDenied(method);
    }

    let snapshot;
    try {
      snapshot = sanitizeSnapshot(input.contacts || []);
    } catch {
      this.audit.append({
        event: 'ANDROID_CONTACT_SNAPSHOT_REJECTED',
        data: {
          method,
          reason: 'invalid_contact_snapshot',
          resource_id: 'android-contact-snapshot',
        },
      });

      return clone({
        ok: false,
        method,
        candidate_count: 0,
        proposals: [],
        mutated: false,
        authority_granted: false,
        error: 'invalid_contact_snapshot',
        assistant_text:
          '연락처 형식을 확인하지 못했어요. 연락처는 변경하지 않았어요.',
      });
    }

    try {
      const core = this._coreForSnapshot(snapshot);
      const result = await core.contacts.propose(core.capability, {
        method,
        subject: input.subject || 'android:local',
        device_id: input.device_id || 'android:local',
        connector: 'android-contact-snapshot',
        idempotency_key:
          input.idempotency_key ||
          `android-contact-read:${input.device_id || 'local'}:${method}`,
        permission_ok: true,
        gate_context: { policy_ok: true },
        limit: input.limit,
        now: input.now,
      });

      if (result.proposed !== true) {
        return clone({
          ok: false,
          method,
          candidate_count: 0,
          proposals: [],
          mutated: false,
          authority_granted: false,
          error: result.status || 'contact_read_not_completed',
          assistant_text:
            '연락처 읽기 확인을 완료하지 못했어요. 연락처는 변경하지 않았어요.',
        });
      }

      const proposals = result.proposals.map(mapProposal);
      const count = result.analysis.candidate_count || 0;

      this.audit.append({
        event: 'ANDROID_CONTACT_ANALYSIS_COMPLETED',
        action_id:
          result.read_result &&
          result.read_result.runtime_action &&
          result.read_result.runtime_action.runtime_action_id,
        execution_id:
          result.read_result &&
          result.read_result.execution &&
          result.read_result.execution.execution_id,
        data: {
          method,
          candidate_count: count,
          proposal_count: proposals.length,
          resource_id: 'android-contact-snapshot',
          mutated: false,
        },
      });

      return clone({
        ok: true,
        method,
        candidate_count: count,
        proposals,
        mutated: false,
        merge_executed: false,
        delete_executed: false,
        authority_granted: false,
        assistant_text:
          count > 0
            ? `중복 가능성이 있는 연락처 ${count}쌍을 찾았어요. 아직 아무것도 합치거나 삭제하지 않았어요.`
            : '지금 기준으로 정리 후보를 찾지 못했어요. 연락처는 변경하지 않았어요.',
      });
    } finally {
      /**
       * Ephemeral only — discard local reference.
       */
      snapshot = null;
    }
  }

  createNetlifyHandler() {
    const api = this;

    return async function handler(event) {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      };

      if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
      }

      if (event.httpMethod !== 'POST') {
        return {
          statusCode: 405,
          headers,
          body: JSON.stringify({
            ok: false,
            candidate_count: 0,
            proposals: [],
            mutated: false,
            authority_granted: false,
            error: 'method_not_allowed',
          }),
        };
      }

      let body = {};
      try {
        body =
          typeof event.body === 'string'
            ? JSON.parse(event.body || '{}')
            : event.body || {};
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            ok: false,
            candidate_count: 0,
            proposals: [],
            mutated: false,
            authority_granted: false,
            error: 'invalid_json',
          }),
        };
      }

      try {
        const view = await api.analyze({
          method: body.method,
          contacts: body.contacts,
          permission_granted: body.permission_granted,
          client: body.client,
          subject: body.subject,
          device_id: body.device_id,
          idempotency_key: body.idempotency_key,
          now: body.now,
          limit: body.limit,
        });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(view),
        };
      } catch (error) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            ok: false,
            candidate_count: 0,
            proposals: [],
            mutated: false,
            authority_granted: false,
            error: 'analyze_failed',
            assistant_text:
              '지금은 분석을 완료하지 못했어요. 연락처는 변경하지 않았어요.',
          }),
        };
      }
    };
  }
}

module.exports = {
  AndroidContactApi,
  sanitizeSnapshot,
  mapProposal,
  normalizeMethod,
};
