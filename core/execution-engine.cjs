'use strict';

const crypto = require('crypto');

const {
  ACTION_RUNTIME_STATUS,
} = require('./action-runtime.cjs');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix = 'exe') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeError(error) {
  if (!error) {
    return {
      name: 'Error',
      message: 'unknown_error',
    };
  }

  return {
    name:
      error.name ||
      'Error',

    message:
      String(
        error.message ||
        error
      ).slice(0, 2000),

    code:
      error.code ||
      null,
  };
}

function withTimeout(promise, timeoutMs) {
  const ms =
    Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : 10000;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer =
        setTimeout(() => {
          const error =
            new Error(
              `execution_timeout_${ms}`
            );

          error.code =
            'EXECUTION_TIMEOUT';

          reject(error);
        }, ms);

      if (
        typeof timer.unref ===
        'function'
      ) {
        timer.unref();
      }
    }),
  ]);
}

class ExecutionEngine {
  constructor(opts = {}) {
    if (!opts.actionRuntime) {
      throw new Error(
        'actionRuntime is required'
      );
    }

    if (!opts.auditEngine) {
      throw new Error(
        'auditEngine is required'
      );
    }

    this.runtime =
      opts.actionRuntime;

    this.audit =
      opts.auditEngine;

    this.connectors =
      new Map();

    this._executions =
      new Map();

    this._idempotency =
      new Map();

    if (opts.connectors) {
      if (
        opts.connectors instanceof
        Map
      ) {
        for (
          const [
            key,
            connector,
          ]
          of opts.connectors
        ) {
          this.registerConnector(
            key,
            connector
          );
        }
      } else if (
        typeof opts.connectors ===
        'object'
      ) {
        for (
          const [
            key,
            connector,
          ]
          of Object.entries(
            opts.connectors
          )
        ) {
          this.registerConnector(
            key,
            connector
          );
        }
      }
    }
  }

  registerConnector(
    name,
    connector
  ) {
    if (
      typeof name !== 'string' ||
      name.trim() === ''
    ) {
      throw new Error(
        'connector name is required'
      );
    }

    if (
      !connector ||
      typeof connector.execute !==
        'function'
    ) {
      throw new Error(
        'connector.execute is required'
      );
    }

    this.connectors.set(
      name.trim(),
      connector
    );
  }

  getExecution(id) {
    const item =
      this._executions.get(id);

    return item
      ? clone(item)
      : null;
  }

  listExecutions() {
    return [
      ...this._executions.values(),
    ].map(clone);
  }

  async execute(
    runtimeActionOrId,
    opts = {}
  ) {
    const action =
      typeof runtimeActionOrId ===
        'string'
        ? this.runtime.get(
            runtimeActionOrId
          )
        : clone(
            runtimeActionOrId
          );

    if (!action) {
      throw new Error(
        'runtime action not found'
      );
    }

    if (
      action.status !==
      ACTION_RUNTIME_STATUS.READY
    ) {
      throw new Error(
        'runtime action is not READY'
      );
    }

    if (
      !action.idempotency_key
    ) {
      throw new Error(
        'idempotency_key missing'
      );
    }

    /**
     * 이미 완료/시도된 동일 key가 있으면
     * connector를 다시 호출하지 않는다.
     */
    if (
      this._idempotency.has(
        action.idempotency_key
      )
    ) {
      const executionId =
        this._idempotency.get(
          action.idempotency_key
        );

      const previous =
        this.getExecution(
          executionId
        );

      return {
        ...previous,
        idempotent_replay: true,
      };
    }

    const connector =
      this.connectors.get(
        action.connector
      );

    if (!connector) {
      throw new Error(
        `connector_not_registered:${action.connector}`
      );
    }

    const executionId =
      makeId();

    const execution = {
      execution_id:
        executionId,

      runtime_action_id:
        action.runtime_action_id,

      decision_id:
        action.decision_id,

      idempotency_key:
        action.idempotency_key,

      connector:
        action.connector,

      status:
        ACTION_RUNTIME_STATUS.EXECUTING,

      attempts: 0,

      connector_result: null,
      verification: null,
      error: null,

      authority_derived_from_connector:
        false,

      started_at:
        new Date().toISOString(),

      finished_at: null,
    };

    /**
     * key는 connector 호출 전에 예약한다.
     * 동시/재진입 duplicate 방지.
     */
    this._idempotency.set(
      action.idempotency_key,
      executionId
    );

    this._executions.set(
      executionId,
      clone(execution)
    );

    this.runtime.setStatus(
      action.runtime_action_id,
      ACTION_RUNTIME_STATUS.EXECUTING,
      {
        execution_id:
          executionId,
      }
    );

    this.audit.append({
      event:
        'EXECUTION_STARTED',

      action_id:
        action.runtime_action_id,

      execution_id:
        executionId,

      decision_id:
        action.decision_id,

      data: {
        connector:
          action.connector,

        idempotency_key:
          action.idempotency_key,

        risk:
          action.risk,
      },
    });

    const maxAttempts =
      1 +
      (
        action.retry_safe
          ? action.max_retries
          : 0
      );

    let lastError = null;
    let connectorResult = null;

    for (
      let attempt = 1;
      attempt <= maxAttempts;
      attempt++
    ) {
      execution.attempts =
        attempt;

      try {
        connectorResult =
          await withTimeout(
            Promise.resolve(
              connector.execute(
                clone(action)
              )
            ),
            opts.timeoutMs
          );

        if (
          connectorResult &&
          connectorResult.ok === false
        ) {
          const err =
            new Error(
              connectorResult.error ||
              'connector_execution_failed'
            );

          err.code =
            'CONNECTOR_REJECTED';

          throw err;
        }

        lastError = null;
        break;
      } catch (error) {
        lastError =
          normalizeError(error);

        this.audit.append({
          event:
            'EXECUTION_ATTEMPT_FAILED',

          action_id:
            action.runtime_action_id,

          execution_id:
            executionId,

          decision_id:
            action.decision_id,

          data: {
            attempt,
            error:
              lastError,
          },
        });
      }
    }

    if (lastError) {
      const failed = {
        ...execution,
        status:
          ACTION_RUNTIME_STATUS.FAILED,
        error:
          lastError,
        finished_at:
          new Date().toISOString(),
      };

      this._executions.set(
        executionId,
        clone(failed)
      );

      this.runtime.setStatus(
        action.runtime_action_id,
        ACTION_RUNTIME_STATUS.FAILED,
        {
          error:
            lastError,
          execution_id:
            executionId,
        }
      );

      this.audit.append({
        event:
          'EXECUTION_FAILED',

        action_id:
          action.runtime_action_id,

        execution_id:
          executionId,

        decision_id:
          action.decision_id,

        data: {
          attempts:
            failed.attempts,
          error:
            lastError,
        },
      });

      return clone(failed);
    }

    /**
     * Connector output은 단순 외부 데이터다.
     * connector_result.authority_granted=true 같은 값은
     * 절대 권한 proof로 사용하지 않는다.
     */
    const succeeded = {
      ...execution,

      status:
        ACTION_RUNTIME_STATUS.SUCCEEDED,

      connector_result:
        clone(
          connectorResult
        ),

      authority_derived_from_connector:
        false,

      finished_at:
        new Date().toISOString(),
    };

    this._executions.set(
      executionId,
      clone(succeeded)
    );

    this.runtime.setStatus(
      action.runtime_action_id,
      ACTION_RUNTIME_STATUS.SUCCEEDED,
      {
        execution_id:
          executionId,
      }
    );

    this.audit.append({
      event:
        'EXECUTION_SUCCEEDED',

      action_id:
        action.runtime_action_id,

      execution_id:
        executionId,

      decision_id:
        action.decision_id,

      data: {
        attempts:
          succeeded.attempts,

        connector_result:
          clone(
            connectorResult
          ),

        authority_derived_from_connector:
          false,
      },
    });

    if (
      action.verify_required &&
      typeof connector.verify ===
        'function'
    ) {
      return this.verify(
        executionId,
        opts
      );
    }

    return clone(
      succeeded
    );
  }

  async verify(
    executionId,
    opts = {}
  ) {
    const execution =
      this.getExecution(
        executionId
      );

    if (!execution) {
      throw new Error(
        'execution not found'
      );
    }

    if (
      execution.status !==
        ACTION_RUNTIME_STATUS.SUCCEEDED &&
      execution.status !==
        ACTION_RUNTIME_STATUS.VERIFY_FAILED
    ) {
      throw new Error(
        'execution cannot be verified in current state'
      );
    }

    const action =
      this.runtime.get(
        execution.runtime_action_id
      );

    const connector =
      this.connectors.get(
        execution.connector
      );

    if (
      !connector ||
      typeof connector.verify !==
        'function'
    ) {
      const verified = {
        ...execution,

        status:
          ACTION_RUNTIME_STATUS.VERIFIED,

        verification: {
          ok: true,
          skipped: true,
          reason:
            'connector_verify_not_available',
        },
      };

      this._executions.set(
        executionId,
        clone(verified)
      );

      this.runtime.setStatus(
        action.runtime_action_id,
        ACTION_RUNTIME_STATUS.VERIFIED
      );

      this.audit.append({
        event:
          'VERIFICATION_SKIPPED',

        action_id:
          action.runtime_action_id,

        execution_id:
          executionId,

        decision_id:
          action.decision_id,

        data:
          verified.verification,
      });

      return clone(
        verified
      );
    }

    let verification;

    try {
      verification =
        await withTimeout(
          Promise.resolve(
            connector.verify(
              clone(action),
              clone(
                execution
                  .connector_result
              )
            )
          ),
          opts.timeoutMs
        );
    } catch (error) {
      verification = {
        ok: false,
        error:
          normalizeError(error),
      };
    }

    const ok =
      verification &&
      verification.ok !== false;

    const next = {
      ...execution,

      status:
        ok
          ? ACTION_RUNTIME_STATUS.VERIFIED
          : ACTION_RUNTIME_STATUS.VERIFY_FAILED,

      verification:
        clone(
          verification
        ),
    };

    this._executions.set(
      executionId,
      clone(next)
    );

    this.runtime.setStatus(
      action.runtime_action_id,
      next.status,
      {
        verification:
          clone(
            verification
          ),
      }
    );

    this.audit.append({
      event:
        ok
          ? 'VERIFICATION_SUCCEEDED'
          : 'VERIFICATION_FAILED',

      action_id:
        action.runtime_action_id,

      execution_id:
        executionId,

      decision_id:
        action.decision_id,

      data: {
        verification:
          clone(
            verification
          ),
      },
    });

    return clone(next);
  }

  async rollback(
    executionId,
    opts = {}
  ) {
    const execution =
      this.getExecution(
        executionId
      );

    if (!execution) {
      throw new Error(
        'execution not found'
      );
    }

    if (
      execution.status !== ACTION_RUNTIME_STATUS.SUCCEEDED &&
      execution.status !== ACTION_RUNTIME_STATUS.VERIFY_FAILED &&
      execution.status !== ACTION_RUNTIME_STATUS.VERIFIED
    ) {
      throw new Error(
        'execution cannot be rolled back in current state'
      );
    }

    const action =
      this.runtime.get(
        execution.runtime_action_id
      );

    if (!action) {
      throw new Error(
        'runtime action not found'
      );
    }

    if (!action.reversible) {
      throw new Error(
        'irreversible action cannot be rolled back'
      );
    }

    const connector =
      this.connectors.get(
        execution.connector
      );

    if (
      !connector ||
      typeof connector.rollback !==
        'function'
    ) {
      throw new Error(
        'connector rollback is not available'
      );
    }

    let result;

    try {
      result =
        await withTimeout(
          Promise.resolve(
            connector.rollback(
              clone(action),
              clone(
                execution
                  .connector_result
              )
            )
          ),
          opts.timeoutMs
        );
    } catch (error) {
      const normalized =
        normalizeError(error);

      this.audit.append({
        event:
          'ROLLBACK_FAILED',

        action_id:
          action.runtime_action_id,

        execution_id:
          executionId,

        decision_id:
          action.decision_id,

        data: {
          error:
            normalized,
        },
      });

      throw error;
    }

    if (
      result &&
      result.ok === false
    ) {
      this.audit.append({
        event:
          'ROLLBACK_FAILED',

        action_id:
          action.runtime_action_id,

        execution_id:
          executionId,

        decision_id:
          action.decision_id,

        data: {
          connector_result:
            clone(result),
        },
      });

      throw new Error(
        result.error ||
        'rollback_failed'
      );
    }

    const rolledBack = {
      ...execution,

      status:
        ACTION_RUNTIME_STATUS.ROLLED_BACK,

      rollback_result:
        clone(result),

      rolled_back_at:
        new Date().toISOString(),
    };

    this._executions.set(
      executionId,
      clone(rolledBack)
    );

    this.runtime.setStatus(
      action.runtime_action_id,
      ACTION_RUNTIME_STATUS.ROLLED_BACK,
      {
        rollback_result:
          clone(result),
      }
    );

    this.audit.append({
      event:
        'ROLLBACK_SUCCEEDED',

      action_id:
        action.runtime_action_id,

      execution_id:
        executionId,

      decision_id:
        action.decision_id,

      data: {
        rollback_result:
          clone(result),
      },
    });

    return clone(
      rolledBack
    );
  }
}

module.exports = {
  ExecutionEngine,
  normalizeError,
  withTimeout,
};
