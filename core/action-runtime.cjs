'use strict';

const crypto = require('crypto');

const ACTION_RUNTIME_STATUS = Object.freeze({
  READY: 'READY',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  VERIFIED: 'VERIFIED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
});

const HIGH_RISK = new Set([
  'HIGH',
  'CRITICAL',
]);

/**
 * Runtime status is a small, explicit state machine.  Keeping it here (rather
 * than trusting every caller) prevents an adapter or connector from marking an
 * action as verified, failed, or rolled back out of order.
 */
const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  [ACTION_RUNTIME_STATUS.READY]: [ACTION_RUNTIME_STATUS.EXECUTING],
  [ACTION_RUNTIME_STATUS.EXECUTING]: [
    ACTION_RUNTIME_STATUS.SUCCEEDED,
    ACTION_RUNTIME_STATUS.FAILED,
  ],
  [ACTION_RUNTIME_STATUS.SUCCEEDED]: [
    ACTION_RUNTIME_STATUS.VERIFIED,
    ACTION_RUNTIME_STATUS.VERIFY_FAILED,
    ACTION_RUNTIME_STATUS.ROLLED_BACK,
  ],
  [ACTION_RUNTIME_STATUS.VERIFY_FAILED]: [
    ACTION_RUNTIME_STATUS.VERIFIED,
    ACTION_RUNTIME_STATUS.VERIFY_FAILED,
    ACTION_RUNTIME_STATUS.ROLLED_BACK,
  ],
  [ACTION_RUNTIME_STATUS.VERIFIED]: [ACTION_RUNTIME_STATUS.ROLLED_BACK],
  [ACTION_RUNTIME_STATUS.FAILED]: [],
  [ACTION_RUNTIME_STATUS.ROLLED_BACK]: [],
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix = 'run') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function hasGateCheck(gateResult, gateName) {
  return Boolean(
    gateResult &&
    gateResult.checks &&
    gateResult.checks[gateName] &&
    gateResult.checks[gateName].ok === true
  );
}

class ActionRuntime {
  constructor(opts = {}) {
    this.audit = opts.auditEngine || null;
    this._actions = new Map();
  }

  prepare(input = {}) {
    if (!isPlainObject(input)) {
      throw new Error('runtime input must be a plain object');
    }

    const {
      decision,
      gate_result: gateResult,
    } = input;

    if (!isPlainObject(decision)) {
      throw new Error('decision is required');
    }

    if (!isPlainObject(gateResult)) {
      throw new Error('gate_result is required');
    }

    if (gateResult.result !== 'ALLOW') {
      throw new Error('gate_result must be ALLOW');
    }

    /**
     * Gate의 execute_ready:false는 의도된 계약이다.
     * Runtime만 별도의 READY 상태를 생성한다.
     */
    if (gateResult.execute_ready === true) {
      throw new Error(
        'gate_result must not self-authorize execution'
      );
    }

    if (
      typeof input.idempotency_key !== 'string' ||
      input.idempotency_key.trim() === ''
    ) {
      throw new Error('idempotency_key is required');
    }

    if (
      typeof input.connector !== 'string' ||
      input.connector.trim() === ''
    ) {
      throw new Error('connector is required');
    }

    const risk =
      decision.risk ||
      input.risk ||
      'MEDIUM';

    const reversible =
      input.reversible !== undefined
        ? input.reversible === true
        : decision.reversibility !== 'IRREVERSIBLE';

    /**
     * HIGH/CRITICAL은 Gate ALLOW만으로 부족하다.
     * explicit Authority proof가 반드시 있어야 한다.
     */
    if (
      HIGH_RISK.has(risk) &&
      !hasGateCheck(gateResult, 'AUTHORITY')
    ) {
      throw new Error(
        'high-risk execution requires explicit AUTHORITY proof'
      );
    }

    const requiredGates = Array.isArray(decision.required_gates)
      ? decision.required_gates
      : [];

    if (
      requiredGates.includes('BIOMETRIC_ASSERTION') &&
      !hasGateCheck(gateResult, 'BIOMETRIC_ASSERTION')
    ) {
      throw new Error(
        'required biometric proof is missing'
      );
    }

    const action = {
      runtime_action_id:
        input.runtime_action_id || makeId('actrun'),

      decision_id:
        decision.id || null,

      gate_id:
        gateResult.audit &&
        gateResult.audit.decision_id
          ? `gate:${gateResult.audit.decision_id}`
          : null,

      platform:
        input.platform ||
        decision.platform_id ||
        null,

      domain:
        decision.domain || null,

      action:
        decision.action || null,

      skill:
        input.skill ||
        decision.skill ||
        null,

      title:
        input.title ||
        decision.title ||
        null,

      payload:
        clone(input.payload || {}),

      connector:
        input.connector.trim(),

      idempotency_key:
        input.idempotency_key.trim(),

      risk,

      reversible,

      retry_safe:
        input.retry_safe === true,

      max_retries:
        Number.isInteger(input.max_retries) &&
        input.max_retries >= 0
          ? input.max_retries
          : 0,

      verify_required:
        input.verify_required !== false,

      status:
        ACTION_RUNTIME_STATUS.READY,

      gate_provenance: {
        gate_result: gateResult.result,
        required_gates: clone(
          decision.required_gates || []
        ),
        authority_proof:
          hasGateCheck(gateResult, 'AUTHORITY'),

        biometric_proof:
          hasGateCheck(
            gateResult,
            'BIOMETRIC_ASSERTION'
          ),

        consent_id:
          gateResult.checks &&
          gateResult.checks.CONSENT &&
          gateResult.checks.CONSENT.consent
            ? gateResult.checks.CONSENT.consent.id
            : null,

        authority_id:
          gateResult.checks &&
          gateResult.checks.AUTHORITY &&
          gateResult.checks.AUTHORITY.grant
            ? gateResult.checks.AUTHORITY.grant.id
            : null,
      },

      created_at:
        input.created_at ||
        new Date().toISOString(),
    };

    this._actions.set(
      action.runtime_action_id,
      clone(action)
    );

    if (this.audit) {
      this.audit.append({
        event: 'ACTION_READY',
        action_id: action.runtime_action_id,
        decision_id: action.decision_id,
        gate_id: action.gate_id,
        data: {
          connector: action.connector,
          risk: action.risk,
          reversible: action.reversible,
          idempotency_key:
            action.idempotency_key,
          gate_provenance:
            action.gate_provenance,
        },
      });
    }

    return clone(action);
  }

  get(id) {
    const item =
      this._actions.get(id);

    return item ? clone(item) : null;
  }

  list() {
    return [
      ...this._actions.values(),
    ].map(clone);
  }

  setStatus(id, status, extra = {}) {
    if (
      !Object.values(
        ACTION_RUNTIME_STATUS
      ).includes(status)
    ) {
      throw new Error(
        'invalid runtime status'
      );
    }

    const stored =
      this._actions.get(id);

    if (!stored) {
      throw new Error(
        'runtime action not found'
      );
    }

    const allowed =
      ALLOWED_STATUS_TRANSITIONS[stored.status] || [];

    if (!allowed.includes(status)) {
      throw new Error(
        `invalid runtime status transition:${stored.status}->${status}`
      );
    }

    if (
      status === ACTION_RUNTIME_STATUS.ROLLED_BACK &&
      stored.reversible !== true
    ) {
      throw new Error('irreversible runtime action cannot be rolled back');
    }

    const next = {
      ...stored,
      ...clone(extra),
      status,
      updated_at:
        new Date().toISOString(),
    };

    this._actions.set(
      id,
      clone(next)
    );

    return clone(next);
  }

  clear() {
    this._actions.clear();
  }
}

module.exports = {
  ActionRuntime,
  ACTION_RUNTIME_STATUS,
  ALLOWED_STATUS_TRANSITIONS,
  HIGH_RISK,
  hasGateCheck,
};
