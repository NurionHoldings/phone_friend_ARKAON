'use strict';

/**
 * Phone Friend Web API Adapter
 * ─────────────────────────────────────────────────
 * Presentation bridge only. No Core logic reimplementation.
 *
 * Browser → (Netlify Function) → this adapter → PhoneFriendRuntime → CORE
 */

const {
  PhoneFriendRuntime,
} = require('../../products/phone-friend/runtime/phone-friend-runtime.cjs');
const {
  ConversationSessionStore,
} = require('../../products/phone-friend/sessions/conversation-session-store.cjs');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function pickAssistantText(result) {
  if (!result) return '잠시만요. 다시 말씀해 주세요.';

  if (result.assistant_text) {
    return result.assistant_text;
  }

  if (result.chat && result.chat.text) {
    return result.chat.text;
  }

  if (
    result.conversation &&
    result.conversation.response &&
    result.conversation.response.text
  ) {
    return result.conversation.response.text;
  }

  if (result.scenario === 'SAFETY_TEXT') {
    const risk = result.risk || 'UNKNOWN';
    return `이 문자에서 위험 신호가 보여요. 위험도 ${risk}. 개인정보나 송금 요청에는 응하지 마세요.`;
  }

  if (result.scenario === 'DOCUMENT_CONVERT') {
    if (result.status === 'BLOCKED_BY_SAFETY') {
      return '이 파일에서 위험 신호가 발견돼서 변환을 멈췄어요. 파일은 삭제하지 않았고, 실행하지도 않았어요.';
    }
    if (result.status === 'SAFETY_REVIEW_REQUIRED') {
      return '파일을 변환하기 전에 한 번 더 확인이 필요해 보여요.';
    }
    if (result.executed) {
      return '사전검사 후 문서 변환을 준비했어요.';
    }
  }

  if (result.scenario === 'CALL_HANDOFF') {
    return '전화 대행은 ARKAON CALL이 담당해요. 여기서는 직접 통화 권한을 쓰지 않아요.';
  }

  if (result.scenario === 'IMAGE') {
    if (result.status === 'IMAGE_NOT_IMPLEMENTED') {
      return '사진 보정은 아직 준비 중이에요. 지금은 실행하지 않아요.';
    }
    return '사진을 SNS에 올리는 건 개인정보 공유로 보여서, 지금은 바로 실행하지 않고 확인이 필요해요.';
  }

  if (result.scenario === 'MESSAGE_READ' && result.executed) {
    const messages =
      (result.capability_result &&
        result.capability_result.execution &&
        result.capability_result.execution.connector_result &&
        result.capability_result.execution.connector_result.messages) ||
      [];
    if (messages.length === 0) {
      return '확인된 문자가 없어요. 보내거나 지우지는 않았어요.';
    }
    return `최근 문자 ${messages.length}건을 확인했어요. 보내거나 지우지는 않았어요.`;
  }

  if (result.scenario === 'LIFE_AGENT' || result.scenario === 'FINANCIAL') {
    return '이 작업은 본인확인과 권한이 필요해요. 지금은 진행을 보류했어요.';
  }

  if (result.status === 'WAITING_CONFIRMATION') {
    return '진행하기 전에 한 번 확인이 필요해요.';
  }

  if (result.status === 'SESSION_EXPIRED') {
    return '대화가 만료됐어요. 처음부터 다시 말씀해 주세요.';
  }

  return '요청을 확인했어요.';
}

function normalizeUiStatus(result) {
  const status = String((result && result.status) || '');

  if (status === 'WAITING_CONFIRMATION' || status === 'WAITING_PERMISSION') {
    return 'CONFIRM';
  }
  if (status === 'CLARIFY') return 'CLARIFY';
  if (status === 'HOLD' || status === 'CANCELLED') return 'HOLD';
  if (status === 'DENY' || status === 'SESSION_EXPIRED') return 'DENY';
  if (status === 'BLOCKED_BY_SAFETY') return 'HOLD';
  if (status === 'WARN') return 'WARN';
  if (status === 'HANDOFF') return 'HANDOFF';
  if (status === 'COMPLETE' || (result && result.executed === true)) {
    return 'COMPLETE';
  }
  if (status === 'CHAT' || status === 'ANSWER') return 'ANSWER';
  return status || 'ANSWER';
}

function buildCards(result) {
  const cards = [];
  if (!result) return cards;

  if (result.scenario === 'CALENDAR_READ' && result.capability_result) {
    const events =
      (result.capability_result.execution &&
        result.capability_result.execution.connector_result &&
        result.capability_result.execution.connector_result.events) ||
      [];

    cards.push({
      type: 'calendar',
      title: '오늘 일정',
      events: events.map((event) => ({
        title: event.title,
        start_at: event.start_at,
      })),
    });
  }

  if (
    result.scenario === 'CALENDAR_WRITE' &&
    result.executed &&
    result.capability_result
  ) {
    const event =
      result.capability_result.execution &&
      result.capability_result.execution.connector_result &&
      result.capability_result.execution.connector_result.event;

    if (event) {
      cards.push({
        type: 'calendar',
        title: '일정 등록 완료',
        events: [
          {
            title: event.title,
            start_at: event.start_at,
          },
        ],
      });
    }
  }

  if (result.status === 'WAITING_CONFIRMATION') {
    const text =
      (result.conversation &&
        result.conversation.response &&
        result.conversation.response.text) ||
      '이 작업을 진행할까요?';

    cards.push({
      type: 'confirm',
      title: '확인이 필요해요',
      text,
      actions: ['응', '아니'],
    });
  }

  if (result.status === 'WAITING_PERMISSION') {
    cards.push({
      type: 'confirm',
      title: '연락처 읽기 권한',
      text:
        result.assistant_text ||
        '연락처를 읽으려면 접근 권한이 필요해요. 읽기만 하고 수정하거나 삭제하지 않을게요.',
      actions: ['허용', '나중에'],
    });
  }

  if (result.scenario === 'MESSAGE_SEND' && result.executed) {
    const message =
      result.capability_result &&
      result.capability_result.execution &&
      result.capability_result.execution.connector_result &&
      result.capability_result.execution.connector_result.message;

    if (message) {
      cards.push({
        type: 'message',
        title: '문자 전송 준비 완료',
        to: message.to,
        content: message.content,
      });
    }
  }

  if (result.scenario === 'MESSAGE_READ' && result.capability_result) {
    const messages =
      (result.capability_result.execution &&
        result.capability_result.execution.connector_result &&
        result.capability_result.execution.connector_result.messages) ||
      [];

    cards.push({
      type: 'message_list',
      title: '최근 문자',
      messages: messages.map((message) => ({
        from: message.from,
        to: message.to,
        content: message.content,
        sent_at: message.sent_at,
      })),
      note: '조회만 했고, 보내거나 지우지 않았어요.',
    });
  }

  if (result.scenario === 'SAFETY_TEXT') {
    cards.push({
      type: 'safety',
      title: '문자 위험 검사',
      risk: result.risk || 'UNKNOWN',
      findings: Array.isArray(result.findings) ? result.findings : [],
      note: '검사는 참고용이며, 절대 안전 보증이 아닙니다.',
    });
  }

  if (result.scenario === 'DOCUMENT_CONVERT') {
    if (result.status === 'BLOCKED_BY_SAFETY') {
      cards.push({
        type: 'safety',
        title: '파일 사전검사',
        risk:
          (result.safety_decision && result.safety_decision.risk) ||
          'HIGH',
        findings: [],
        note: '위험 신호로 변환을 중단했고, 파일은 삭제하지 않았습니다.',
      });
    } else if (result.executed) {
      const doc =
        result.capability_result &&
        result.capability_result.conversion_result &&
        result.capability_result.conversion_result.execution &&
        result.capability_result.conversion_result.execution
          .connector_result &&
        result.capability_result.conversion_result.execution
          .connector_result.document;

      cards.push({
        type: 'document',
        title: '문서 변환 결과',
        document: doc
          ? {
              source_filename: doc.source_filename,
              output_format: doc.output_format,
              safety_scan_id: doc.safety_scan_id,
            }
          : null,
      });
    }
  }

  if (result.scenario === 'CALL_HANDOFF') {
    cards.push({
      type: 'handoff',
      title: 'ARKAON CALL',
      product:
        (result.handoff && result.handoff.product) || 'ARKAON_CALL',
      text: '전화 전문축으로 연결합니다. PHONE FRIEND는 통화 권한을 행사하지 않습니다.',
    });
  }

  if (result.cards_hint && result.cards_hint.type === 'contact') {
    cards.push({
      type: 'contact',
      title: '연락처 정리 후보',
      duplicate_group_count: result.cards_hint.duplicate_group_count,
      duplicate_contact_count: result.cards_hint.duplicate_contact_count,
      note: '읽기만 했어요. 삭제/합치기는 하지 않았어요.',
    });
  }

  if (Array.isArray(result.options) && result.options.length) {
    cards.push({
      type: 'options',
      title: '이렇게 도와드릴까요?',
      options: result.options,
    });
  }

  return cards;
}

function toViewModel(result) {
  const sessionId =
    (result &&
      result.conversation &&
      result.conversation.session &&
      result.conversation.session.id) ||
    (result && result.natural_session_id) ||
    null;

  const progress = Array.isArray(result && result.progress)
    ? result.progress
    : [];

  const mood =
    (result && result.character_mood) ||
    (progress.length ? progress[progress.length - 1].mood : 'LISTENING');

  return clone({
    session_id: sessionId,
    natural_session_id:
      (result && result.natural_session_id) || sessionId,
    continuation_token:
      (result && result.conversation && result.conversation.session &&
        result.conversation.session.continuation_token) || null,
    status: normalizeUiStatus(result),
    scenario: (result && result.scenario) || null,
    assistant_text: pickAssistantText(result),
    executed: Boolean(result && result.executed),
    /**
     * Presentation never grants authority.
     */
    authority_granted: false,
    cards: buildCards(result),
    progress,
    character_mood: mood,
    presence_label:
      (result && result.presence_label) || null,
    raw_status: (result && result.status) || null,
  });
}

class PhoneFriendWebApi {
  constructor(opts = {}) {
    this.runtime =
      opts.runtime || new PhoneFriendRuntime({
        ...(opts.runtimeOpts || {}),
        /** Public HTTP sessions never accept session_id as a credential. */
        sessionStore:
          (opts.runtimeOpts && opts.runtimeOpts.sessionStore) ||
          new ConversationSessionStore({
            requireContinuationToken: true,
          }),
      });
  }

  async handleTurn(input = {}) {
    const utterance = String(input.utterance || input.text || '').trim();

    if (!utterance) {
      return clone({
        session_id: input.session_id || null,
        status: 'CLARIFY',
        scenario: null,
        assistant_text: '무엇을 도와드릴까요?',
        executed: false,
        authority_granted: false,
        cards: [],
      });
    }

    const result = await this.runtime.handle({
      utterance,
      session_id: input.session_id || null,
      natural_session_id: input.natural_session_id || null,
      subject: input.subject || 'user:web',
      device_id: input.device_id || 'web-device',
      filename: input.filename,
      source: input.source,
      source_text: input.source_text,
      mime_type: input.mime_type,
      suspect_text: input.suspect_text,
      idempotency_key: input.idempotency_key,
      safety_idempotency_key: input.safety_idempotency_key,
      policy_ok: input.policy_ok,
      now: input.now || new Date(),
      llmSuggestion: input.llmSuggestion,
      forceAuthority: input.forceAuthority,
      gate_context: input.gate_context,
      permission_ok: input.permission_ok,
      continuation_token: input.continuation_token,
    });

    const view = toViewModel(result);

    /**
     * The token is issued only at session creation; for an accepted
     * continuation the client already holds it, so it may be echoed without
     * putting it into session storage or Audit.
     */
    if (
      !view.continuation_token &&
      view.status !== 'DENY' &&
      input.session_id &&
      typeof input.continuation_token === 'string' &&
      input.continuation_token !== ''
    ) {
      view.continuation_token = input.continuation_token;
    }

    return view;
  }
}

/**
 * Netlify-style handler factory.
 */
function createNetlifyHandler(opts = {}) {
  const api = opts.api || new PhoneFriendWebApi(opts);

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
          error: 'method_not_allowed',
          authority_granted: false,
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
          error: 'invalid_json',
          authority_granted: false,
        }),
      };
    }

    try {
      const view = await api.handleTurn(body);
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
          error: 'phone_friend_failed',
          message: String(error && error.message ? error.message : error),
          authority_granted: false,
        }),
      };
    }
  };
}

module.exports = {
  PhoneFriendWebApi,
  createNetlifyHandler,
  toViewModel,
  buildCards,
  normalizeUiStatus,
  pickAssistantText,
};
