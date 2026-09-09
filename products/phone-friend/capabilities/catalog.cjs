'use strict';

/**
 * Phone Friend Capability Catalog
 * ─────────────────────────────────────────────────
 * Product/Capability Layer — NOT Core.
 *
 * Capability는 기능 단위일 뿐 Authority가 아니다.
 * 실제 위험·게이트·실행은 항상 ARKAON CORE Decision/Gate가 결정한다.
 */

const { DOMAINS, ACTIONS } = require('../../../core/decision-engine.cjs');

const PRODUCT_ID = 'PHONE_FRIEND';

/**
 * Phone Friend Capability 축
 * (ARKAON CALL은 별도 제품축 — 여기서는 CALL capability로만 연결)
 */
const CAPABILITY = Object.freeze({
  FRIEND_CHAT: 'FRIEND_CHAT',
  CALENDAR: 'CALENDAR',
  MESSAGING: 'MESSAGING',
  CONTACT: 'CONTACT',
  CALL: 'CALL',
  SAFETY_GUARD: 'SAFETY_GUARD',
  DIGITAL_SUPPORT: 'DIGITAL_SUPPORT',
  LIFE_AGENT: 'LIFE_AGENT',
  IMAGE: 'IMAGE',
});

/**
 * 세분화된 skill action (Capability 내부 동작)
 */
const SKILL_ACTION = Object.freeze({
  CHAT: 'CHAT',
  CALENDAR_READ: 'CALENDAR_READ',
  CALENDAR_WRITE: 'CALENDAR_WRITE',
  MESSAGE_READ: 'MESSAGE_READ',
  MESSAGE_SEND: 'MESSAGE_SEND',
  CONTACT_READ: 'CONTACT_READ',
  CONTACT_ANALYZE: 'CONTACT_ANALYZE',
  CONTACT_PROPOSE: 'CONTACT_PROPOSE',
  CALL_PROXY: 'CALL_PROXY',
  CALL_RISK_ANALYSIS: 'CALL_RISK_ANALYSIS',
  CALL_BLOCK: 'CALL_BLOCK',
  DOCUMENT_CONVERT: 'DOCUMENT_CONVERT',
  KIOSK_ASSIST: 'KIOSK_ASSIST',
  IMAGE_EDIT: 'IMAGE_EDIT',
  IMAGE_SHARE: 'IMAGE_SHARE',
  MONEY_TRANSFER: 'MONEY_TRANSFER',
  UNKNOWN: 'UNKNOWN',
});

const CATALOG = Object.freeze({
  [CAPABILITY.FRIEND_CHAT]: Object.freeze({
    id: CAPABILITY.FRIEND_CHAT,
    label: '대화·상담',
    default_risk: 'LOW',
    core_domain: DOMAINS.GENERAL_ASSISTANT,
    core_action: ACTIONS.READ,
  }),
  [CAPABILITY.CALENDAR]: Object.freeze({
    id: CAPABILITY.CALENDAR,
    label: '일정 조회/등록',
    default_risk: 'LOW_MEDIUM',
    core_domain: DOMAINS.GENERAL_ASSISTANT,
    core_action: ACTIONS.READ,
  }),
  [CAPABILITY.MESSAGING]: Object.freeze({
    id: CAPABILITY.MESSAGING,
    label: '문자 읽기/발송',
    default_risk: 'LOW_MEDIUM',
    core_domain: DOMAINS.COMMUNICATION,
    core_action: ACTIONS.WRITE,
  }),
  [CAPABILITY.CONTACT]: Object.freeze({
    id: CAPABILITY.CONTACT,
    label: '연락처 읽기·분석·제안',
    default_risk: 'MEDIUM',
    core_domain: DOMAINS.PRIVACY,
    core_action: ACTIONS.READ,
    /**
     * v0.1: MERGE/DELETE는 카탈로그에도 올리지 않는다.
     */
    mutate_skills: Object.freeze([]),
  }),
  [CAPABILITY.CALL]: Object.freeze({
    id: CAPABILITY.CALL,
    label: '전화·대리수신',
    default_risk: 'MEDIUM',
    core_domain: DOMAINS.COMMUNICATION,
    core_action: ACTIONS.EXECUTE,
    handoff_product: 'ARKAON_CALL',
  }),
  [CAPABILITY.SAFETY_GUARD]: Object.freeze({
    id: CAPABILITY.SAFETY_GUARD,
    label: '피싱·악성파일·URL 검사',
    default_risk: 'LOW_HIGH',
    core_domain: DOMAINS.SAFETY,
    core_action: ACTIONS.WARN,
  }),
  [CAPABILITY.DIGITAL_SUPPORT]: Object.freeze({
    id: CAPABILITY.DIGITAL_SUPPORT,
    label: '문서변환·쉬운 설명',
    default_risk: 'LOW',
    core_domain: DOMAINS.GENERAL_ASSISTANT,
    core_action: ACTIONS.READ,
  }),
  [CAPABILITY.LIFE_AGENT]: Object.freeze({
    id: CAPABILITY.LIFE_AGENT,
    label: '키오스크·예약·주문 지원',
    default_risk: 'MEDIUM_HIGH',
    core_domain: DOMAINS.DEVICE,
    core_action: ACTIONS.EXECUTE,
  }),
  [CAPABILITY.IMAGE]: Object.freeze({
    id: CAPABILITY.IMAGE,
    label: '셀카/사진 보정',
    default_risk: 'LOW_MEDIUM',
    core_domain: DOMAINS.GENERAL_ASSISTANT,
    core_action: ACTIONS.WRITE,
  }),
});

/** skill action → product capability */
const SKILL_TO_CAPABILITY = Object.freeze({
  [SKILL_ACTION.CHAT]: CAPABILITY.FRIEND_CHAT,
  [SKILL_ACTION.CALENDAR_READ]: CAPABILITY.CALENDAR,
  [SKILL_ACTION.CALENDAR_WRITE]: CAPABILITY.CALENDAR,
  [SKILL_ACTION.MESSAGE_READ]: CAPABILITY.MESSAGING,
  [SKILL_ACTION.MESSAGE_SEND]: CAPABILITY.MESSAGING,
  [SKILL_ACTION.CONTACT_READ]: CAPABILITY.CONTACT,
  [SKILL_ACTION.CONTACT_ANALYZE]: CAPABILITY.CONTACT,
  [SKILL_ACTION.CONTACT_PROPOSE]: CAPABILITY.CONTACT,
  [SKILL_ACTION.CALL_PROXY]: CAPABILITY.CALL,
  [SKILL_ACTION.CALL_RISK_ANALYSIS]: CAPABILITY.SAFETY_GUARD,
  [SKILL_ACTION.CALL_BLOCK]: CAPABILITY.SAFETY_GUARD,
  [SKILL_ACTION.DOCUMENT_CONVERT]: CAPABILITY.DIGITAL_SUPPORT,
  [SKILL_ACTION.KIOSK_ASSIST]: CAPABILITY.LIFE_AGENT,
  [SKILL_ACTION.IMAGE_EDIT]: CAPABILITY.IMAGE,
  [SKILL_ACTION.IMAGE_SHARE]: CAPABILITY.IMAGE,
  [SKILL_ACTION.MONEY_TRANSFER]: CAPABILITY.LIFE_AGENT,
  [SKILL_ACTION.UNKNOWN]: CAPABILITY.FRIEND_CHAT,
});

function getCapability(id) {
  return CATALOG[id] || null;
}

function resolveProductCapability(skillAction) {
  return SKILL_TO_CAPABILITY[skillAction] || CAPABILITY.FRIEND_CHAT;
}

module.exports = {
  PRODUCT_ID,
  CAPABILITY,
  SKILL_ACTION,
  CATALOG,
  SKILL_TO_CAPABILITY,
  getCapability,
  resolveProductCapability,
};
