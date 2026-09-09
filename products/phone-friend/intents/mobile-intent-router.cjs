'use strict';

/**
 * MobileIntentRouter
 * ─────────────────────────────────────────────────
 * PHONE FRIEND — Product/Capability Layer
 *
 * 자연어 발화를 구조화된 Intent로 변환합니다.
 *
 * 핵심 원칙:
 *   - 라우터 출력은 Intent일 뿐 Authority가 아니다.
 *   - LLM/해석기 결과는 실행 권한이 아니다.
 *   - 위험도·게이트·실행은 ARKAON CORE Decision / Gate / Runtime이 결정한다.
 *
 * v0.1: deterministic pattern router (한국어 모바일 비서)
 */

const {
  DOMAINS,
  ACTIONS,
} = require('../../../core/decision-engine.cjs');

const {
  PRODUCT_ID,
  resolveProductCapability,
  SKILL_ACTION,
} = require('../capabilities/catalog.cjs');

/** @deprecated use SKILL_ACTION — kept for test/API compat */
const CAPABILITIES = Object.freeze({
  CALENDAR_READ: SKILL_ACTION.CALENDAR_READ,
  MESSAGE_READ: SKILL_ACTION.MESSAGE_READ,
  MESSAGE_SEND: SKILL_ACTION.MESSAGE_SEND,
  CALL_RISK_ANALYSIS: SKILL_ACTION.CALL_RISK_ANALYSIS,
  CALL_BLOCK: SKILL_ACTION.CALL_BLOCK,
  MONEY_TRANSFER: SKILL_ACTION.MONEY_TRANSFER,
  UNKNOWN: SKILL_ACTION.UNKNOWN,
});

const INTENT_SOURCE = Object.freeze({
  DETERMINISTIC_ROUTER: 'DETERMINISTIC_ROUTER',
  LLM_SUGGESTION: 'LLM_SUGGESTION',
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseAmount(text) {
  const normalized = String(text || '');

  // 30만원, 3만원
  const man = normalized.match(/(\d+(?:\.\d+)?)\s*만\s*원/);
  if (man) {
    return Math.round(Number(man[1]) * 10000);
  }

  // 300000원 / 300,000원
  const won = normalized.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/);
  if (won) {
    return Number(won[1].replace(/,/g, ''));
  }

  // 보내줘 앞의 숫자만 (만원 단위 추정 방지: 명시적 원 없으면 null)
  return null;
}

function extractRecipient(text) {
  // "엄마한테", "김사장에게", "김○○한테"
  const m = String(text || '').match(
    /([가-힣A-Za-z0-9○]+?)(?:한테|에게|께)/
  );
  return m ? m[1] : null;
}

function extractMessageContent(text) {
  // "늦는다고 문자" / "'3시에 전화드리겠습니다'라고"
  const quoted = String(text || '').match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];

  const tell = String(text || '').match(
    /(?:한테|에게|께)\s*(.+?)(?:라고\s*)?(?:알려|말해|전해)/
  );
  if (tell) {
    return tell[1]
      .replace(/좀\s*/g, '')
      .replace(/보내[줘라세요]*$/g, '')
      .trim();
  }

  const m = String(text || '').match(
    /(?:한테|에게|께)\s*(.+?)(?:라고\s*)?(?:문자|메시지|톡)/
  );
  if (m) {
    return m[1]
      .replace(/보내[줘라세요]*$/g, '')
      .replace(/한다고$/g, '한다고')
      .trim();
  }

  // "늦는다고 문자 보내줘"
  const m2 = String(text || '').match(
    /([가-힣A-Za-z0-9\s]+?)(?:이라고|다고|라고)?\s*(?:문자|메시지)/
  );
  if (m2) {
    let content = m2[1].trim();
    // strip recipient prefix if present
    content = content.replace(/^[가-힣A-Za-z0-9○]+(?:한테|에게|께)\s*/, '');
    return content || null;
  }

  return null;
}

function buildIntent(partial) {
  const capability = partial.capability || SKILL_ACTION.UNKNOWN;
  return {
    product: PRODUCT_ID,
    product_capability: resolveProductCapability(capability),
    domain: partial.domain,
    action: partial.action,
    capability,
    title: partial.title || '',
    slots: clone(partial.slots || {}),
    missing_slots: Array.isArray(partial.missing_slots)
      ? [...partial.missing_slots]
      : [],
    confidence: Number.isFinite(partial.confidence)
      ? Math.max(0, Math.min(1, partial.confidence))
      : 0.8,
    source: partial.source || INTENT_SOURCE.DETERMINISTIC_ROUTER,
    /**
     * Router never grants authority.
     */
    authority_granted: false,
    raw_text: partial.raw_text || '',
  };
}

class MobileIntentRouter {
  /**
   * 자연어 → Intent
   * opts.llmSuggestion이 있어도 Authority로 취급하지 않는다.
   */
  route(utterance, opts = {}) {
    const text = normalizeText(utterance);

    if (!text) {
      return buildIntent({
        domain: DOMAINS.GENERAL_ASSISTANT,
        action: ACTIONS.READ,
        capability: CAPABILITIES.UNKNOWN,
        title: 'empty utterance',
        missing_slots: ['utterance'],
        confidence: 0,
        raw_text: text,
      });
    }

    // Optional LLM suggestion: only merge slots if domain/action already safe;
    // never promote LLM output to authority.
    const llm = opts.llmSuggestion && typeof opts.llmSuggestion === 'object'
      ? clone(opts.llmSuggestion)
      : null;

    let intent = null;

    // FINANCIAL / TRANSFER
    if (
      /(보내|송금|이체)/.test(text) &&
      (/(원|만\s*원)/.test(text) || parseAmount(text) !== null)
    ) {
      const amount = parseAmount(text);
      const recipient = extractRecipient(text);
      const missing = [];
      if (amount === null) missing.push('amount');
      if (!recipient) missing.push('recipient');

      intent = buildIntent({
        domain: DOMAINS.FINANCIAL,
        action: ACTIONS.TRANSFER,
        capability: CAPABILITIES.MONEY_TRANSFER,
        title: text,
        slots: {
          amount,
          recipient,
          currency: 'KRW',
        },
        missing_slots: missing,
        confidence: 0.9,
        raw_text: text,
      });
    }

    // SAFETY / BLOCK
    else if (/(차단|막아|받지\s*마)/.test(text) && /(번호|전화|통화|콜)/.test(text)) {
      intent = buildIntent({
        domain: DOMAINS.SAFETY,
        action: ACTIONS.BLOCK,
        capability: CAPABILITIES.CALL_BLOCK,
        title: text,
        slots: {
          target: extractRecipient(text) || 'current_number',
        },
        missing_slots: [],
        confidence: 0.88,
        raw_text: text,
      });
    }

    // SAFETY / WARN — 수상/피싱/위험
    else if (
      /(수상|피싱|위험|이상|의심)/.test(text) &&
      /(전화|통화|콜|번호)/.test(text)
    ) {
      intent = buildIntent({
        domain: DOMAINS.SAFETY,
        action: ACTIONS.WARN,
        capability: CAPABILITIES.CALL_RISK_ANALYSIS,
        title: text,
        slots: {
          target: 'current_call',
        },
        missing_slots: [],
        confidence: 0.86,
        raw_text: text,
      });
    }

    // COMMUNICATION / READ — 문자 조회 (SEND·SAFETY보다 좁은 패턴)
    else if (
      /(문자|메시지|톡)/.test(text) &&
      /(읽|조회|보여|확인|목록|받은|최근)/.test(text) &&
      !/(보내|전송|이상|수상|위험|피싱|검사)/.test(text)
    ) {
      const recipient = extractRecipient(text);
      intent = buildIntent({
        domain: DOMAINS.COMMUNICATION,
        action: ACTIONS.READ,
        capability: CAPABILITIES.MESSAGE_READ,
        title: text,
        slots: {
          recipient,
          limit: 10,
        },
        missing_slots: [],
        confidence: 0.86,
        raw_text: text,
      });
    }

    // COMMUNICATION / WRITE — 문자 발송 + paraphrase ("알려줘", "말해놔")
    else if (
      (/(문자|메시지|톡)/.test(text) && /(보내|전송)/.test(text)) ||
      (/보내줘/.test(text) && /(문자|메시지)/.test(text)) ||
      (/(한테|에게|께)/.test(text) &&
        /(알려줘|알려\s*줘|말해줘|말해놔|전해줘)/.test(text))
    ) {
      const recipient = extractRecipient(text);
      const content = extractMessageContent(text);
      const missing = [];
      if (!recipient) missing.push('recipient');
      if (!content) missing.push('content');

      intent = buildIntent({
        domain: DOMAINS.COMMUNICATION,
        action: ACTIONS.WRITE,
        capability: CAPABILITIES.MESSAGE_SEND,
        title: text,
        slots: {
          recipient,
          content,
        },
        missing_slots: missing,
        confidence: 0.87,
        raw_text: text,
      });
    }

    // IMAGE — 셀카/보정 vs SNS 공유 escalate는 policy에서
    else if (/(셀카|보정|사진\s*고쳐|이미지\s*편집)/.test(text)) {
      intent = buildIntent({
        domain: DOMAINS.GENERAL_ASSISTANT,
        action: ACTIONS.WRITE,
        capability: SKILL_ACTION.IMAGE_EDIT,
        title: text,
        slots: {
          share: /(sns|인스타|올려|공유|게시)/i.test(text),
          destination: /(sns|인스타)/i.test(text) ? 'sns' : null,
        },
        missing_slots: [],
        confidence: 0.84,
        raw_text: text,
      });
    }

    // LIFE_AGENT — 키오스크/주문 (결제는 policy escalate)
    else if (/(키오스크|짜장면|주문해|메뉴\s*골라)/.test(text)) {
      const payment = /(결제|카드\s*결제|결제해)/.test(text);
      intent = buildIntent({
        domain: DOMAINS.DEVICE,
        action: payment ? ACTIONS.TRANSFER : ACTIONS.EXECUTE,
        capability: SKILL_ACTION.KIOSK_ASSIST,
        title: text,
        slots: {
          item: /짜장면/.test(text) ? '짜장면' : null,
          payment,
          amount: parseAmount(text),
        },
        missing_slots: [],
        confidence: 0.8,
        raw_text: text,
      });
    }

    // GENERAL / READ — 일정 (+ "오늘 뭐 있지?")
    else if (
      (/(일정|스케줄|캘린더)/.test(text) && /(알려|보여|뭐|있)/.test(text)) ||
      /오늘\s*뭐\s*있/.test(text)
    ) {
      intent = buildIntent({
        domain: DOMAINS.GENERAL_ASSISTANT,
        action: ACTIONS.READ,
        capability: CAPABILITIES.CALENDAR_READ,
        title: text,
        slots: {
          timeframe: /오늘/.test(text)
            ? 'today'
            : /내일/.test(text)
              ? 'tomorrow'
              : 'unspecified',
        },
        missing_slots: [],
        confidence: 0.92,
        raw_text: text,
      });
    }

    // fallback
    else {
      intent = buildIntent({
        domain: DOMAINS.GENERAL_ASSISTANT,
        action: ACTIONS.READ,
        capability: CAPABILITIES.UNKNOWN,
        title: text,
        slots: {},
        missing_slots: ['clarification'],
        confidence: 0.3,
        raw_text: text,
      });
    }

    // LLM suggestion may only fill missing slots — never override domain/action/authority
    if (llm && intent.missing_slots.length > 0) {
      const filled = { ...intent.slots };
      const stillMissing = [];

      for (const slot of intent.missing_slots) {
        if (llm.slots && llm.slots[slot] !== undefined && llm.slots[slot] !== null) {
          filled[slot] = clone(llm.slots[slot]);
        } else {
          stillMissing.push(slot);
        }
      }

      intent = buildIntent({
        ...intent,
        slots: filled,
        missing_slots: stillMissing,
        source: INTENT_SOURCE.DETERMINISTIC_ROUTER,
        // Even if LLM contributed slots, authority stays false
        authority_granted: false,
      });
      intent.llm_assisted_slots = true;
    }

    // Explicit: reject any attempt to inject authority via router input
    if (opts.forceAuthority === true || (llm && llm.authority_granted === true)) {
      intent.authority_granted = false;
      intent.authority_injection_ignored = true;
    }

    return clone(intent);
  }
}

module.exports = {
  MobileIntentRouter,
  CAPABILITIES,
  INTENT_SOURCE,
  parseAmount,
  extractRecipient,
  extractMessageContent,
  normalizeText,
};
