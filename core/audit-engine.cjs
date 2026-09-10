'use strict';

const crypto = require('crypto');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  const keys = Object.keys(value).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
}

function hashEntry(entry) {
  return crypto
    .createHash('sha256')
    .update(stableSerialize(entry))
    .digest('hex');
}

const SENSITIVE_AUDIT_KEY = /(?:^|_)(?:sms|message|content|body|text|phone|phones|telephone|tel|mobile|contact|contacts|name|names|email|emails|recipient|continuation|token|secret)(?:$|_)/i;

function redactValue(value, key = '') {
  if (SENSITIVE_AUDIT_KEY.test(key)) {
    const item = {
      redacted: true,
      sha256: hashEntry({ value }),
    };

    if (Array.isArray(value) || typeof value === 'string') {
      item.count = Array.isArray(value) ? value.length : String(value).length;
    }

    return item;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ])
    );
  }

  return clone(value);
}

function redactAuditData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return redactValue(data);
  }

  return redactValue(data);
}

class AuditEngine {
  constructor() {
    this._entries = [];
  }

  append(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('audit entry must be a plain object');
    }

    if (typeof input.event !== 'string' || input.event.trim() === '') {
      throw new Error('audit.event is required');
    }

    const previous =
      this._entries.length > 0
        ? this._entries[this._entries.length - 1]
        : null;

    const body = {
      sequence: this._entries.length + 1,
      event: input.event.trim(),
      action_id: input.action_id || null,
      execution_id: input.execution_id || null,
      decision_id: input.decision_id || null,
      gate_id: input.gate_id || null,
      subject: input.subject || null,
      data: redactAuditData(input.data || {}),
      created_at: input.created_at || new Date().toISOString(),
      previous_hash: previous ? previous.hash : null,
    };

    const entry = {
      ...body,
      hash: hashEntry(body),
    };

    this._entries.push(clone(entry));
    return clone(entry);
  }

  list(filter = {}) {
    let rows = this._entries.map(clone);

    if (filter.action_id) {
      rows = rows.filter((row) => row.action_id === filter.action_id);
    }

    if (filter.execution_id) {
      rows = rows.filter(
        (row) => row.execution_id === filter.execution_id
      );
    }

    if (filter.event) {
      rows = rows.filter((row) => row.event === filter.event);
    }

    return rows;
  }

  get(sequence) {
    const n = Number(sequence);

    if (!Number.isInteger(n) || n < 1) {
      return null;
    }

    const item = this._entries[n - 1];
    return item ? clone(item) : null;
  }

  verifyChain() {
    let previousHash = null;

    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];

      const body = {
        sequence: entry.sequence,
        event: entry.event,
        action_id: entry.action_id,
        execution_id: entry.execution_id,
        decision_id: entry.decision_id,
        gate_id: entry.gate_id,
        subject: entry.subject,
        data: clone(entry.data),
        created_at: entry.created_at,
        previous_hash: entry.previous_hash,
      };

      if (entry.previous_hash !== previousHash) {
        return {
          ok: false,
          broken_at: entry.sequence,
          reason: 'previous_hash_mismatch',
        };
      }

      const expected = hashEntry(body);

      if (expected !== entry.hash) {
        return {
          ok: false,
          broken_at: entry.sequence,
          reason: 'entry_hash_mismatch',
        };
      }

      previousHash = entry.hash;
    }

    return {
      ok: true,
      entries: this._entries.length,
    };
  }

  size() {
    return this._entries.length;
  }

  /**
   * 의도적으로 update/delete API는 제공하지 않는다.
   * Audit trail은 append-only다.
   */
  clearForTestsOnly() {
    this._entries = [];
  }
}

module.exports = {
  AuditEngine,
  stableSerialize,
  hashEntry,
  redactAuditData,
};
