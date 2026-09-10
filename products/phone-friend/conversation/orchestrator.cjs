'use strict';

/**
 * ConversationOrchestrator
 * ─────────────────────────────────────────────────
 * PHONE FRIEND — Product/Capability Layer
 *
 * User Conversation
 *   → Mobile Intent Router
 *   → Capability Policy (escalate to Core domains)
 *   → Session (multi-turn)
 *   → ARKAON CORE Decision Engine
 *   → ARKAON CORE Gate Engine (optional)
 *   → Natural-language Response
 *
 * Product/LLM/Router는 Intent만 만든다.
 * 실행 여부는 CORE Decision / Gate / Runtime이 결정한다.
 * Capability는 CORE Gate를 우회할 수 없다.
 */

const {
  DecisionEngine,
  DOMAINS,
  ACTIONS,
  EXECUTION_MODE,
} = require('../../../core/decision-engine.cjs');
const { MobileIntentRouter } = require('../intents/mobile-intent-router.cjs');
const {
  ConversationSessionStore,
  SESSION_STATUS,
} = require('../sessions/conversation-session-store.cjs');
const { resolveCoreTarget } = require('../policies/capability-policy.cjs');
const { PRODUCT_ID } = require('../capabilities/catalog.cjs');

const RESPONSE_KIND = Object.freeze({
  ANSWER: 'ANSWER',
  CLARIFY: 'CLARIFY',
  CONFIRM: 'CONFIRM',
  HOLD: 'HOLD',
  DENY: 'DENY',
  COMPLETE: 'COMPLETE',
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isAffirmative(text) {
  return /^(응|어|네|예|좋아|ㅇㅇ|yes|ok|okay|확인|보내|진행)(?:요|습니다)?[!~.]*$/i.test(
    String(text || '').trim()
  );
}

function isNegative(text) {
  return /^(아니|괜찮아|취소|그만|no|ㄴㄴ)(?:야|요|습니다)?[!~.]*$/i.test(
    String(text || '').trim()
  );
}

function renderResponse(kind, text, extra = {}) {
  return clone({
    kind,
    text,
    ...extra,
    /**
     * Conversation response never grants authority.
     */
    authority_granted: false,
  });
}

class ConversationOrchestrator {
  constructor(opts = {}) {
    this.router = opts.intentRouter || new MobileIntentRouter();
    this.sessions = opts.sessionStore || new ConversationSessionStore();
    this.decisions = opts.decisionEngine || new DecisionEngine();
    this.gateEngine = opts.gateEngine || null;
    this.audit = opts.auditEngine || null;
    this.contacts = Array.isArray(opts.contacts) ? clone(opts.contacts) : [];
  }

  _attachIssuedContinuation(result, token) {
    if (!token || !result || !result.session) return result;

    return {
      ...result,
      session: {
        ...result.session,
        continuation_token: token,
      },
    };
  }

  /**
   * 한 턴 처리.
   *
   * input:
   * {
   *   utterance, subject?, device_id?,
   *   session_id?,
   *   llmSuggestion?,
   *   gate_context?,
   *   now?
   * }
   */
  handle(input = {}) {
    const now = input.now ? new Date(input.now) : new Date();
    const utterance = String(input.utterance || '').trim();

    let session = null;
    let issuedContinuationToken = null;

    if (input.session_id) {
      session = this.sessions.get(input.session_id, now);
      if (session && session.status === SESSION_STATUS.EXPIRED) {
        return {
          session,
          intent: null,
          decision: null,
          gate_result: null,
          response: renderResponse(
            RESPONSE_KIND.DENY,
            '대화 세션이 만료되었습니다. 다시 말씀해 주세요.'
          ),
        };
      }

      const continuation = this.sessions.validateContinuation(
        input.session_id,
        input.continuation_token,
        now
      );

      if (!continuation.ok) {
        if (this.audit) {
          this.audit.append({
            event: 'CONVERSATION_SESSION_BINDING_DENIED',
            data: {
              resource_id: input.session_id,
              reason: continuation.reason,
              expected_subject_bound: Boolean(session && session.subject),
              expected_device_bound: Boolean(session && session.device_id),
            },
          });
        }

        return {
          session: session ? clone(session) : null,
          intent: null,
          decision: null,
          gate_result: null,
          response: renderResponse(
            RESPONSE_KIND.DENY,
            '이 대화는 계속할 수 없습니다. 새로 시작해 주세요.'
          ),
        };
      }

      if (
        session &&
        !this.sessions.bindingMatches(session, {
          subject: input.subject,
          device_id: input.device_id,
        })
      ) {
        if (this.audit) {
          this.audit.append({
            event: 'CONVERSATION_SESSION_BINDING_DENIED',
            subject: session.subject || null,
            data: {
              resource_id: session.id,
              reason: 'subject_or_device_mismatch',
              expected_subject_bound: Boolean(session.subject),
              expected_device_bound: Boolean(session.device_id),
            },
          });
        }

        return {
          session: clone(session),
          intent: null,
          decision: null,
          gate_result: null,
          response: renderResponse(
            RESPONSE_KIND.DENY,
            '이 대화는 현재 사용자 또는 기기에서 계속할 수 없습니다.'
          ),
        };
      }
    }

    // Continuation: confirmation answer
    if (
      session &&
      session.status === SESSION_STATUS.WAITING_CONFIRMATION
    ) {
      return this._handleConfirmation(session, utterance, input, now);
    }

    // Continuation: slot / ambiguity answer
    if (
      session &&
      (session.status === SESSION_STATUS.WAITING_SLOT ||
        session.pending_question)
    ) {
      return this._handleSlotFill(session, utterance, input, now);
    }

    // New or continuing with fresh intent
    const intent = this.router.route(utterance, {
      llmSuggestion: input.llmSuggestion,
      forceAuthority: input.forceAuthority,
    });

    if (!session) {
      session = this.sessions.create({
        subject: input.subject || null,
        device_id: input.device_id || null,
        intent,
        slots: intent.slots,
        now,
      });
      issuedContinuationToken = session.continuation_token || null;
    } else {
      session = this.sessions.update(
        session.id,
        {
          intent,
          slots: {
            ...session.slots,
            ...intent.slots,
          },
          status: SESSION_STATUS.ACTIVE,
        },
        now
      );
      session = this.sessions.touch(session.id, now);
    }

    session = this.sessions.appendTurn(
      session.id,
      { role: 'user', text: utterance, at: now.toISOString() },
      now
    );

    return this._attachIssuedContinuation(
      this._advance(session, intent, input, now),
      issuedContinuationToken
    );
  }

  _handleConfirmation(session, utterance, input, now) {
    session = this.sessions.appendTurn(
      session.id,
      { role: 'user', text: utterance, at: now.toISOString() },
      now
    );

    if (isNegative(utterance)) {
      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.CANCELLED,
          confirmed: false,
        },
        now
      );

      const response = renderResponse(
        RESPONSE_KIND.COMPLETE,
        '알겠습니다. 취소했습니다.'
      );

      session = this.sessions.appendTurn(
        session.id,
        { role: 'assistant', text: response.text, at: now.toISOString() },
        now
      );

      return {
        session,
        intent: session.intent,
        decision: null,
        gate_result: null,
        response,
      };
    }

    if (!isAffirmative(utterance)) {
      const response = renderResponse(
        RESPONSE_KIND.CONFIRM,
        '진행할까요? "응" 또는 "아니"로 답해 주세요.',
        { awaiting: 'confirmation' }
      );

      session = this.sessions.appendTurn(
        session.id,
        { role: 'assistant', text: response.text, at: now.toISOString() },
        now
      );

      return {
        session,
        intent: session.intent,
        decision: null,
        gate_result: null,
        response,
      };
    }

    session = this.sessions.update(
      session.id,
      {
        confirmed: true,
        status: SESSION_STATUS.ACTIVE,
      },
      now
    );

    return this._advance(session, session.intent, input, now, {
      confirmed: true,
    });
  }

  _handleSlotFill(session, utterance, input, now) {
    session = this.sessions.appendTurn(
      session.id,
      { role: 'user', text: utterance, at: now.toISOString() },
      now
    );

    const intent = clone(session.intent) || {};
    const slots = { ...(session.slots || {}) };
    const missing = [...(intent.missing_slots || [])];

    // Ambiguous recipient disambiguation
    if (
      session.candidate_options &&
      session.candidate_options.length > 0
    ) {
      const chosen = this._resolveCandidate(utterance, session.candidate_options);
      if (!chosen) {
        const response = renderResponse(
          RESPONSE_KIND.CLARIFY,
          '어느 분인지 조금 더 구체적으로 말씀해 주세요.',
          { options: session.candidate_options }
        );
        session = this.sessions.appendTurn(
          session.id,
          { role: 'assistant', text: response.text, at: now.toISOString() },
          now
        );
        return {
          session,
          intent,
          decision: null,
          gate_result: null,
          response,
        };
      }

      slots.recipient = chosen.name;
      slots.recipient_id = chosen.id;
      const idx = missing.indexOf('recipient');
      if (idx >= 0) missing.splice(idx, 1);
    } else if (missing[0]) {
      const slot = missing.shift();
      slots[slot] = utterance.trim();
    }

    intent.slots = slots;
    intent.missing_slots = missing;

    session = this.sessions.update(
      session.id,
      {
        intent,
        slots,
        pending_question: null,
        candidate_options: [],
        status: SESSION_STATUS.ACTIVE,
      },
      now
    );

    return this._advance(session, intent, input, now);
  }

  _resolveCandidate(utterance, options) {
    const text = String(utterance || '');
    return (
      options.find((opt) => {
        if (opt.name && text.includes(opt.name)) return true;
        if (opt.hint && text.includes(opt.hint)) return true;
        if (opt.city && text.includes(opt.city)) return true;
        return false;
      }) || null
    );
  }

  _findRecipientAmbiguity(recipient) {
    if (!recipient || this.contacts.length === 0) return [];
    return this.contacts.filter(
      (c) => c.name === recipient || (c.aliases || []).includes(recipient)
    );
  }

  _advance(session, intent, input, now, flags = {}) {
    const workingIntent = clone(intent);
    const slots = {
      ...(session.slots || {}),
      ...(workingIntent.slots || {}),
    };
    workingIntent.slots = slots;

    // Ambiguous contacts
    if (
      workingIntent.capability === 'MESSAGE_SEND' &&
      slots.recipient
    ) {
      const matches = this._findRecipientAmbiguity(slots.recipient);
      if (matches.length > 1 && !slots.recipient_id) {
        session = this.sessions.update(
          session.id,
          {
            status: SESSION_STATUS.WAITING_SLOT,
            pending_question: 'ambiguous_recipient',
            candidate_options: matches,
            intent: workingIntent,
            slots,
          },
          now
        );

        const labels = matches
          .map((m) => m.hint || m.city || m.name)
          .join(', ');

        const response = renderResponse(
          RESPONSE_KIND.CLARIFY,
          `${slots.recipient} 연락처가 ${matches.length}개 있습니다. 어느 분인가요? (${labels})`,
          { options: matches }
        );

        session = this.sessions.appendTurn(
          session.id,
          { role: 'assistant', text: response.text, at: now.toISOString() },
          now
        );

        return {
          session,
          intent: workingIntent,
          decision: null,
          gate_result: null,
          response,
        };
      }
    }

    // Missing slots
    const missing = Array.isArray(workingIntent.missing_slots)
      ? workingIntent.missing_slots.filter((s) => {
          const v = slots[s];
          return v === undefined || v === null || v === '';
        })
      : [];

    workingIntent.missing_slots = missing;

    if (missing.length > 0) {
      const slot = missing[0];
      const ask =
        slot === 'recipient'
          ? '누구에게 보낼까요?'
          : slot === 'content'
            ? '무슨 내용으로 보낼까요?'
            : slot === 'amount'
              ? '얼마를 보낼까요?'
              : '조금 더 구체적으로 말씀해 주세요.';

      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.WAITING_SLOT,
          pending_question: slot,
          intent: workingIntent,
          slots,
        },
        now
      );

      const response = renderResponse(RESPONSE_KIND.CLARIFY, ask, {
        missing_slot: slot,
      });

      session = this.sessions.appendTurn(
        session.id,
        { role: 'assistant', text: response.text, at: now.toISOString() },
        now
      );

      return {
        session,
        intent: workingIntent,
        decision: null,
        gate_result: null,
        response,
      };
    }

    // Decision — Capability Policy로 CORE domain/action 확정 (우회 금지)
    const coreTarget = resolveCoreTarget(workingIntent);
    workingIntent.product = PRODUCT_ID;
    workingIntent.product_capability = coreTarget.product_capability;
    workingIntent.escalation = coreTarget.escalation || null;
    workingIntent.handoff = coreTarget.handoff || null;

    const decision = this.decisions.evaluate(
      {
        domain: coreTarget.domain,
        action: coreTarget.action,
        title: workingIntent.title || workingIntent.raw_text || 'phone-friend intent',
        summary: workingIntent.raw_text || '',
        platform_id: 'phone-friend',
        payload: {
          ...clone(slots),
          product: PRODUCT_ID,
          product_capability: coreTarget.product_capability,
          skill_action: workingIntent.capability,
          escalation: coreTarget.escalation,
          handoff: coreTarget.handoff,
        },
      },
      { now }
    );

    // COMMUNICATION WRITE / POLICY_CHECK → confirmation unless already confirmed
    if (
      decision.execution_mode === EXECUTION_MODE.POLICY_CHECK &&
      !flags.confirmed &&
      !session.confirmed
    ) {
      const preview =
        workingIntent.domain === DOMAINS.COMMUNICATION
          ? `'${slots.content || ''}'라고 ${slots.recipient || '상대'}에게 보낼까요?`
          : decision.action === ACTIONS.BLOCK
            ? `${slots.target || '해당 번호'}를 차단할까요?`
            : '이 작업을 진행할까요?';

      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.WAITING_CONFIRMATION,
          confirmation_required: true,
          intent: workingIntent,
          decision_id: decision.id,
          slots,
        },
        now
      );

      const response = renderResponse(RESPONSE_KIND.CONFIRM, preview, {
        decision_id: decision.id,
        execution_mode: decision.execution_mode,
      });

      session = this.sessions.appendTurn(
        session.id,
        { role: 'assistant', text: response.text, at: now.toISOString() },
        now
      );

      return {
        session,
        intent: workingIntent,
        decision,
        gate_result: null,
        response,
      };
    }

    // Optional gate evaluation
    let gateResult = null;
    if (this.gateEngine && decision.required_gates) {
      const gates = decision.required_gates.filter((g) => g !== 'NONE');
      if (gates.length > 0) {
        gateResult = this.gateEngine.evaluate(decision, {
          ...(input.gate_context || {}),
          subject: input.subject || session.subject,
          device_id: input.device_id || session.device_id,
          action: decision.action,
          domain: decision.domain,
          now,
        });
      }
    }

    let response;

    if (gateResult && gateResult.result === 'DENY') {
      response = renderResponse(
        RESPONSE_KIND.DENY,
        '이 작업은 현재 권한으로 수행할 수 없습니다.',
        { gate_result: gateResult.result }
      );
      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.COMPLETED,
          decision_id: decision.id,
          gate_result: gateResult,
        },
        now
      );
    } else if (gateResult && gateResult.result === 'HOLD') {
      const missing = gateResult.missing_gates || [];
      const askBio = missing.includes('BIOMETRIC_ASSERTION');
      const askId = missing.includes('IDENTITY');
      const askConsent = missing.includes('CONSENT');
      const askAuth = missing.includes('AUTHORITY');

      let text = '추가 확인이 필요합니다.';
      if (askId || askBio) {
        text = '본인확인이 필요합니다. 지문으로 본인확인하시겠습니까?';
      } else if (askConsent) {
        text = '이 작업에 동의하시겠습니까?';
      } else if (askAuth) {
        text = '이 작업을 수행할 권한이 확인되지 않았습니다.';
      }

      response = renderResponse(RESPONSE_KIND.HOLD, text, {
        missing_gates: missing,
        gate_result: gateResult.result,
      });

      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.WAITING_GATE,
          decision_id: decision.id,
          gate_result: gateResult,
        },
        now
      );
    } else if (decision.execution_mode === EXECUTION_MODE.AUTO) {
      response = renderResponse(
        RESPONSE_KIND.ANSWER,
        this._autoAnswer(workingIntent, slots),
        {
          execution_mode: decision.execution_mode,
          decision_id: decision.id,
        }
      );
      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.COMPLETED,
          decision_id: decision.id,
          gate_result: gateResult,
        },
        now
      );
    } else if (
      decision.execution_mode === EXECUTION_MODE.IDENTITY_CONSENT_BIO
    ) {
      // Without gate engine, still explain required gates
      if (!gateResult) {
        response = renderResponse(
          RESPONSE_KIND.HOLD,
          '이 작업은 본인확인과 동의가 필요합니다.',
          {
            execution_mode: decision.execution_mode,
            required_gates: decision.required_gates,
          }
        );
        session = this.sessions.update(
          session.id,
          {
            status: SESSION_STATUS.WAITING_GATE,
            decision_id: decision.id,
          },
          now
        );
      } else if (gateResult.result === 'ALLOW') {
        response = renderResponse(
          RESPONSE_KIND.COMPLETE,
          '권한 검증 완료. 실행 준비가 됐습니다.',
          {
            execution_mode: decision.execution_mode,
            gate_result: gateResult.result,
            execute_ready: false,
          }
        );
        session = this.sessions.update(
          session.id,
          {
            status: SESSION_STATUS.COMPLETED,
            decision_id: decision.id,
            gate_result: gateResult,
          },
          now
        );
      } else {
        response = renderResponse(
          RESPONSE_KIND.HOLD,
          '추가 확인이 필요합니다.',
          {
            execution_mode: decision.execution_mode,
            gate_result: gateResult.result,
            missing_gates: gateResult.missing_gates || [],
          }
        );
        session = this.sessions.update(
          session.id,
          {
            status: SESSION_STATUS.WAITING_GATE,
            decision_id: decision.id,
            gate_result: gateResult,
          },
          now
        );
      }
    } else if (
      flags.confirmed ||
      session.confirmed ||
      decision.execution_mode === EXECUTION_MODE.POLICY_CHECK
    ) {
      // User already confirmed POLICY_CHECK (or equivalent) — ready, not executed.
      response = renderResponse(
        RESPONSE_KIND.COMPLETE,
        workingIntent.capability === 'MESSAGE_SEND'
          ? '확인했습니다. 문자 전송을 준비했습니다.'
          : '확인했습니다. 요청하신 작업을 준비했습니다.',
        {
          execution_mode: decision.execution_mode,
          decision_id: decision.id,
          execute_ready: false,
          gate_result: gateResult ? gateResult.result : null,
        }
      );
      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.COMPLETED,
          decision_id: decision.id,
          gate_result: gateResult,
          confirmed: true,
        },
        now
      );
    } else {
      response = renderResponse(
        RESPONSE_KIND.CONFIRM,
        '이 작업을 진행할까요?',
        { execution_mode: decision.execution_mode }
      );
      session = this.sessions.update(
        session.id,
        {
          status: SESSION_STATUS.WAITING_CONFIRMATION,
          decision_id: decision.id,
        },
        now
      );
    }

    session = this.sessions.appendTurn(
      session.id,
      { role: 'assistant', text: response.text, at: now.toISOString() },
      now
    );

    return {
      session: clone(session),
      intent: clone(workingIntent),
      decision: clone(decision),
      gate_result: gateResult ? clone(gateResult) : null,
      response,
    };
  }

  _autoAnswer(intent, slots) {
    if (intent.capability === 'CALENDAR_READ') {
      const when = slots.timeframe === 'today' ? '오늘' : '요청하신';
      return `${when} 일정을 확인해 드리겠습니다.`;
    }

    if (intent.capability === 'CALL_RISK_ANALYSIS') {
      return '이 전화는 주의가 필요해 보입니다. 개인정보나 금전 요구에 응하지 마세요.';
    }

    return '요청하신 내용을 확인했습니다.';
  }
}

module.exports = {
  ConversationOrchestrator,
  RESPONSE_KIND,
  isAffirmative,
  isNegative,
};
