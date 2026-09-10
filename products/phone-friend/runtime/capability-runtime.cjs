'use strict';

/**
 * CapabilityRuntime
 * ─────────────────────────────────────────────────
 *
 * PHONE FRIEND Capability와 ARKAON CORE 사이의 실행 브리지.
 *
 * Capability
 *   → resolveCoreTarget
 *   → DecisionEngine
 *   → GateEngine
 *   → ActionRuntime
 *   → ExecutionEngine
 *
 * Product Layer는 어떤 단계에서도 Authority를 생성하지 않는다.
 */

const {
  resolveCoreTarget,
} = require(
  '../policies/capability-policy.cjs'
);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isCompletedExecution(status) {
  return status === 'SUCCEEDED' || status === 'VERIFIED';
}

class CapabilityRuntime {
  constructor(opts = {}) {
    if (!opts.decisionEngine) {
      throw new Error(
        'decisionEngine is required'
      );
    }

    if (!opts.gateEngine) {
      throw new Error(
        'gateEngine is required'
      );
    }

    if (!opts.actionRuntime) {
      throw new Error(
        'actionRuntime is required'
      );
    }

    if (!opts.executionEngine) {
      throw new Error(
        'executionEngine is required'
      );
    }

    this.decisions =
      opts.decisionEngine;

    this.gates =
      opts.gateEngine;

    this.actions =
      opts.actionRuntime;

    this.executions =
      opts.executionEngine;
  }

  async executeIntent(
    input = {}
  ) {
    const intent =
      clone(
        input.intent
      );

    if (
      !intent ||
      typeof intent !==
        'object'
    ) {
      throw new Error(
        'intent is required'
      );
    }

    if (
      typeof input.connector !==
        'string' ||
      input.connector.trim() ===
        ''
    ) {
      throw new Error(
        'connector is required'
      );
    }

    if (
      typeof input.idempotency_key !==
        'string' ||
      input.idempotency_key.trim() ===
        ''
    ) {
      throw new Error(
        'idempotency_key is required'
      );
    }

    const now =
      input.now
        ? new Date(
            input.now
          )
        : new Date();

    if (
      Number.isNaN(
        now.getTime()
      )
    ) {
      throw new Error(
        'now is invalid'
      );
    }

    /**
     * Product policy:
     * Intent를 CORE Domain/Action으로만 매핑.
     * 절대 Authority를 만들지 않는다.
     */
    const target =
      resolveCoreTarget(
        intent
      );

    if (
      target
        .authority_granted !==
      false
    ) {
      throw new Error(
        'product policy attempted to grant authority'
      );
    }

    const decision =
      this.decisions.evaluate(
        {
          domain:
            target.domain,

          action:
            target.action,

          title:
            intent.title ||
            intent.capability ||
            'PHONE FRIEND action',

          payload:
            clone(
              intent.slots ||
              {}
            ),

          product:
            'PHONE_FRIEND',

          product_capability:
            target
              .product_capability,

          skill:
            target
              .skill_action,
        },
        {
          now,
        }
      );

    /**
     * Product input으로 Decision authority를
     * 강제로 열 수 없다.
     */
    if (
      decision
        .authority_granted ===
      true
    ) {
      throw new Error(
        'Decision unexpectedly granted authority'
      );
    }

    const gateContext = {
      ...(clone(
        input.gate_context ||
          {}
      )),

      subject:
        input.subject ||
        (
          input.gate_context &&
          input.gate_context
            .subject
        ) ||
        null,

      device_id:
        input.device_id ||
        (
          input.gate_context &&
          input.gate_context
            .device_id
        ) ||
        null,

      action:
        target.action,

      domain:
        target.domain,

      now,
    };

    const gateResult =
      this.gates.evaluate(
        decision,
        gateContext
      );

    if (
      gateResult.result !==
      'ALLOW'
    ) {
      return clone({
        status:
          gateResult.result,

        executed:
          false,

        target,
        intent,
        decision,
        gate_result:
          gateResult,

        authority_granted:
          false,
      });
    }

    /**
     * Gate ALLOW != Execute.
     * ActionRuntime만 READY 상태를 발급한다.
     */
    const runtimeAction =
      this.actions.prepare({
        decision,

        gate_result:
          gateResult,

        platform:
          'phone-friend',

        skill:
          target
            .skill_action,

        title:
          intent.title,

        payload:
          clone(
            intent.slots ||
            {}
          ),

        connector:
          input.connector,

        idempotency_key:
          input.idempotency_key,

        /**
         * 조회는 retry-safe.
         * 쓰기는 명시적인 flag가 있을 때만 retry-safe.
         */
        retry_safe:
          target.action ===
            'READ'
            ? true
            : input.retry_safe ===
              true,

        max_retries:
          Number.isInteger(
            input.max_retries
          )
            ? input.max_retries
            : 0,

        /**
         * SMS 등 비가역 발송은 connector.rollback 부재로 거부.
         * Calendar WRITE는 connector.rollback으로 되돌린다.
         */
        reversible:
          input.reversible !==
          undefined
            ? input.reversible ===
              true
            : target.skill_action !==
              'MESSAGE_SEND',

        verify_required:
          input.verify_required !==
          false,
      });

    const execution =
      await this.executions.execute(
        runtimeAction
          .runtime_action_id,
        {
          timeoutMs:
            input.timeoutMs,
        }
      );

    const completed = isCompletedExecution(execution.status);

    return clone({
      status:
        execution.status,

      /**
       * executed means the requested operation completed successfully, not
       * merely that a connector was invoked.  `attempted` preserves the
       * operational fact for failure diagnostics.
       */
      executed: completed,
      attempted: true,

      target,
      intent,
      decision,
      gate_result:
        gateResult,

      runtime_action:
        runtimeAction,

      execution,

      /**
       * Product/Capability 결과가
       * Authority가 되는 일은 없다.
       */
      authority_granted:
        false,
    });
  }
}

module.exports = {
  CapabilityRuntime,
  isCompletedExecution,
};
