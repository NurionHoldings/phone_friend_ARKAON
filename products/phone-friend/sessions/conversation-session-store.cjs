'use strict';

/**
 * ConversationSessionStore
 * ─────────────────────────────────────────────────
 * PHONE FRIEND — Product/Capability Layer
 *
 * Multi-turn 대화 상태를 보관합니다.
 * StateStore(Core)를 주입받아 Memory / Device / Server로 교체 가능합니다.
 */

const crypto = require('crypto');
const { MemoryStore } = require('../../../core/state-store.cjs');

const SESSION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  WAITING_SLOT: 'WAITING_SLOT',
  WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
  WAITING_GATE: 'WAITING_GATE',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix = 'sess') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function makeContinuationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashContinuationToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token))
    .digest('hex');
}

function hasValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

class ConversationSessionStore {
  constructor(opts = {}) {
    this.store = opts.store || new MemoryStore();
    this.ttlMs =
      Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    /**
     * Public adapters opt in to a bearer continuation token. Keeping the
     * default compatible preserves internal, in-process test harnesses while
     * Netlify/Web never accepts session_id alone.
     */
    this.requireContinuationToken = opts.requireContinuationToken === true;
  }

  _key(id) {
    return `conv:${id}`;
  }

  _getInternal(id, now = new Date()) {
    const session = this.store.get(this._key(id));
    if (!session) return null;

    if (this.isExpired(session, now)) {
      session.status = SESSION_STATUS.EXPIRED;
      this.store.set(this._key(id), session);
    }

    return session;
  }

  _public(session, continuationToken = null) {
    if (!session) return null;
    const result = clone(session);
    delete result.continuation_token_hash;
    if (continuationToken) {
      result.continuation_token = continuationToken;
    }
    return result;
  }

  create(input = {}) {
    const now = input.now ? new Date(input.now) : new Date();
    const id = input.id || makeId();
    const continuationToken = makeContinuationToken();

    const session = {
      id,
      subject: input.subject || null,
      device_id: input.device_id || null,
      /** Raw continuation tokens never enter persistent session state. */
      continuation_token_hash: hashContinuationToken(continuationToken),
      status: SESSION_STATUS.ACTIVE,
      intent: input.intent ? clone(input.intent) : null,
      slots: clone(input.slots || {}),
      pending_question: null,
      candidate_options: [],
      decision_id: null,
      gate_result: null,
      confirmation_required: false,
      confirmed: false,
      turns: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
    };

    this.store.set(this._key(id), session);
    return this._public(session, continuationToken);
  }

  get(id, now = new Date()) {
    return this._public(this._getInternal(id, now));
  }

  validateContinuation(id, token, now = new Date()) {
    const session = this._getInternal(id, now);
    if (!session) return { ok: false, reason: 'session_not_found' };

    if (!this.requireContinuationToken) {
      return { ok: true, session: this._public(session) };
    }

    if (!hasValue(token)) {
      return { ok: false, reason: 'continuation_token_required' };
    }

    const expected = Buffer.from(session.continuation_token_hash || '', 'hex');
    const actual = Buffer.from(hashContinuationToken(token), 'hex');
    const ok =
      expected.length === actual.length &&
      expected.length > 0 &&
      crypto.timingSafeEqual(expected, actual);

    return ok
      ? { ok: true, session: this._public(session) }
      : { ok: false, reason: 'continuation_token_invalid' };
  }

  bindingMatches(session, binding = {}) {
    if (!session) return false;

    const subjectProvided = hasValue(binding.subject);
    const deviceProvided = hasValue(binding.device_id);

    return (
      (!session.subject || (subjectProvided && session.subject === binding.subject)) &&
      (!session.device_id || (deviceProvided && session.device_id === binding.device_id))
    );
  }

  isExpired(session, now = new Date()) {
    if (!session || !session.expires_at) return false;
    const t = now instanceof Date ? now : new Date(now);
    return Date.parse(session.expires_at) <= t.getTime();
  }

  update(id, patch = {}, now = new Date()) {
    const current = this._getInternal(id, now);
    if (!current) {
      throw new Error('session_not_found');
    }

    if (current.status === SESSION_STATUS.EXPIRED) {
      throw new Error('session_expired');
    }

    const next = {
      ...current,
      ...clone(patch),
      id: current.id,
      created_at: current.created_at,
      continuation_token_hash: current.continuation_token_hash,
      updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    };

    // preserve nested merges for slots/turns carefully
    if (patch.slots) {
      next.slots = {
        ...current.slots,
        ...clone(patch.slots),
      };
    }

    if (Array.isArray(patch.turns)) {
      next.turns = clone(patch.turns);
    }

    this.store.set(this._key(id), next);
    return this._public(next);
  }

  appendTurn(id, turn, now = new Date()) {
    const current = this._getInternal(id, now);
    if (!current) throw new Error('session_not_found');
    if (current.status === SESSION_STATUS.EXPIRED) {
      throw new Error('session_expired');
    }

    const turns = [...current.turns, clone(turn)];
    return this.update(id, { turns }, now);
  }

  touch(id, now = new Date()) {
    const t = now instanceof Date ? now : new Date(now);
    return this.update(
      id,
      {
        expires_at: new Date(t.getTime() + this.ttlMs).toISOString(),
      },
      t
    );
  }

  delete(id) {
    return this.store.delete(this._key(id));
  }

  clear() {
    for (const key of this.store.keys()) {
      if (key.startsWith('conv:')) {
        this.store.delete(key);
      }
    }
  }
}

module.exports = {
  ConversationSessionStore,
  SESSION_STATUS,
  DEFAULT_TTL_MS,
  hashContinuationToken,
};
