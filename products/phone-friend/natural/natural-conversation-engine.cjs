'use strict';

/**
 * NaturalConversationEngine v0.1
 * ─────────────────────────────────────────────────
 * Deterministic Korean natural-language interpreter.
 *
 * Output is a Dialogue Plan / structured candidate only.
 * Never grants Authority. Never bypasses Decision/Gate.
 *
 *   Natural language
 *        ↓
 *   Structured Candidate (this layer)
 *        ↓
 *   PHONE FRIEND policy / Conversation
 *        ↓
 *   CORE Decision → Gate → Execution
 */

const {
  PLAN_STATUS,
  RISK_BOUNDARY,
  createDialoguePlan,
} = require('./dialogue-plan.cjs');

const {
  ProgressNarrator,
  PROGRESS_STAGE,
} = require('../progress/progress-narrator.cjs');

const NATURAL_GOAL = Object.freeze({
  CONTACT_MAINTENANCE: 'CONTACT_MAINTENANCE',
  PROGRESS_FEEDBACK: 'PROGRESS_FEEDBACK',
  MESSAGE_READ: 'MESSAGE_READ',
  MESSAGE_SEND: 'MESSAGE_SEND',
  CALENDAR_READ: 'CALENDAR_READ',
  SAFETY_TEXT: 'SAFETY_TEXT',
  DOCUMENT_SIMPLIFY: 'DOCUMENT_SIMPLIFY',
  UNKNOWN: 'UNKNOWN',
});

const CONTACT_METHOD = Object.freeze({
  DUPLICATES: 'DUPLICATES',
  NO_NAME: 'NO_NAME',
  INACTIVE: 'INACTIVE',
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalize(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function isAffirm(text) {
  return /^(응|어|네|예|좋아|허용|허락|ㅇㅇ|ok|okay|그래)(?:요|습니다)?[!~.]*$/i.test(
    normalize(text)
  );
}

function isNeg(text) {
  return /^(아니|괜찮아|취소|그만|나중에|ㄴㄴ|no)(?:야|요|습니다)?[!~.]*$/i.test(
    normalize(text)
  );
}

function extractRecipient(text) {
  const m = String(text || '').match(
    /([가-힣A-Za-z0-9○]+?)(?:한테|에게|께)/
  );
  return m ? m[1] : null;
}

function extractMessageContent(text) {
  const quoted = String(text || '').match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];

  // "엄마한테 나 늦는다고 좀 알려줘"
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

  const m2 = String(text || '').match(
    /([가-힣A-Za-z0-9\s]+?)(?:이라고|다고|라고)?\s*(?:문자|메시지)/
  );
  if (m2) {
    let content = m2[1].trim();
    content = content.replace(
      /^[가-힣A-Za-z0-9○]+(?:한테|에게|께)\s*/,
      ''
    );
    return content || null;
  }

  return null;
}

class NaturalConversationEngine {
  constructor(opts = {}) {
    this.narrator =
      opts.narrator || new ProgressNarrator();
  }

  /**
   * @param {object} input
   * @param {string} input.utterance
   * @param {object|null} input.state
   */
  interpret(input = {}) {
    const text = normalize(input.utterance);
    const state = clone(input.state || null);

    if (!text) {
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.UNKNOWN,
        status: 'CLARIFY',
        assistant_text: '무엇을 도와드릴까요? 편하게 말씀해 주세요.',
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.UNKNOWN,
          status: PLAN_STATUS.CLARIFY,
          missing_slots: ['utterance'],
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
            text: '무엇을 도와드릴지 기다리고 있어요.',
          },
        ],
        state: null,
      });
    }

    if (state && state.goal === NATURAL_GOAL.CONTACT_MAINTENANCE) {
      return this._continueContact(text, state);
    }

    // Progress narration UX contract
    if (
      /(진행\s*과정|진행상황|지금\s*뭐\s*하|말해줘야|알려줘야|먹통)/.test(
        text
      )
    ) {
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.PROGRESS_FEEDBACK,
        status: 'ANSWER',
        assistant_text:
          '맞아요. 앞으로는 지금 무엇을 하고 있는지 짧게 말해줄게요. 예를 들면 “확인하고 있어요”, “권한이 필요해요”, “결과를 정리했어요”처럼요.',
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.PROGRESS_FEEDBACK,
          status: PLAN_STATUS.ANSWERED,
          risk_boundary: RISK_BOUNDARY.NONE,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '진행 안내가 부족했다는 말씀을 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.COMPLETE,
            text: '이제 진행과정을 더 자주 말씀드릴게요.',
            mark: 'done',
          },
        ],
        prefer_progress_narration: true,
        state: null,
      });
    }

    // CONTACT_MAINTENANCE — dialogue + READ/ANALYZE boundary only
    if (this._isContactMaintenance(text)) {
      const methodHint = this._detectContactMethod(text);
      if (methodHint) {
        return this._planContactMethod(methodHint, {
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          step: 'ASK_METHOD',
          method: null,
        });
      }

      return this._result({
        handled: true,
        goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
        status: 'CLARIFY',
        assistant_text:
          '좋아요. 연락처를 바로 변경하지 않고\n먼저 정리할 후보부터 찾아볼게요.\n\n중복 연락처,\n이름 없는 번호,\n오래 사용하지 않은 연락처 중\n어떤 것부터 볼까요?',
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          capability_candidates: ['CONTACT_READ'],
          missing_slots: ['method'],
          ambiguity: ['organize_method'],
          risk_boundary: RISK_BOUNDARY.ANALYZE,
          mutate: false,
          status: PLAN_STATUS.CLARIFY,
          notes: 'No mutate. READ/ANALYZE boundary only in v0.1.',
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '연락처 정리를 원하는 것으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.PLANNING,
            text: '바로 바꾸지 않고 후보부터 찾는 계획을 세웠어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
            text: '어떤 방식부터 볼지 확인하고 있어요.',
            mark: 'active',
          },
        ],
        options: [
          { id: CONTACT_METHOD.DUPLICATES, label: '중복 연락처' },
          { id: CONTACT_METHOD.NO_NAME, label: '이름 없는 번호' },
          { id: CONTACT_METHOD.INACTIVE, label: '오래된 연락처' },
        ],
        state: {
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          step: 'ASK_METHOD',
          method: null,
        },
      });
    }

    // MESSAGE_SEND paraphrases
    if (this._isMessageSend(text)) {
      const recipient = extractRecipient(text);
      const content = extractMessageContent(text);
      const missing = [];
      if (!recipient) missing.push('recipient');
      if (!content) missing.push('content');

      return this._result({
        handled: true,
        goal: NATURAL_GOAL.MESSAGE_SEND,
        status: 'ROUTE_CAPABILITY',
        assistant_text: null,
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.MESSAGE_SEND,
          capability_candidates: ['MESSAGE_SEND'],
          slots: { recipient, content },
          missing_slots: missing,
          risk_boundary: RISK_BOUNDARY.WRITE,
          mutate: false,
          status:
            missing.length > 0
              ? PLAN_STATUS.CLARIFY
              : PLAN_STATUS.READY_FOR_CAPABILITY,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '메시지를 보내고 싶어 하시는 것으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.PLANNING,
            text: '보내기 전에 내용을 확인할게요.',
            mark: 'active',
          },
        ],
        route: {
          kind: 'MESSAGE_SEND',
          utterance: text,
          slots: { recipient, content },
        },
        state: null,
      });
    }

    // MESSAGE_READ paraphrases (after SEND/SAFETY to avoid collision)
    if (this._isMessageRead(text)) {
      const recipient = extractRecipient(text);
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.MESSAGE_READ,
        status: 'ROUTE_CAPABILITY',
        assistant_text: null,
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.MESSAGE_READ,
          capability_candidates: ['MESSAGE_READ'],
          slots: { recipient, limit: 10 },
          risk_boundary: RISK_BOUNDARY.READ,
          mutate: false,
          status: PLAN_STATUS.READY_FOR_CAPABILITY,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '문자 조회 요청으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.ANALYZING,
            text: '최근 문자를 확인하고 있어요.',
            mark: 'active',
          },
        ],
        route: {
          kind: 'MESSAGE_READ',
          utterance: text,
          slots: { recipient, limit: 10 },
        },
        state: null,
      });
    }

    // CALENDAR_READ paraphrases
    if (this._isCalendarRead(text)) {
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.CALENDAR_READ,
        status: 'ROUTE_CAPABILITY',
        assistant_text: null,
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.CALENDAR_READ,
          capability_candidates: ['CALENDAR_READ'],
          slots: {
            timeframe: /오늘/.test(text)
              ? 'today'
              : /내일/.test(text)
                ? 'tomorrow'
                : 'unspecified',
          },
          risk_boundary: RISK_BOUNDARY.READ,
          mutate: false,
          status: PLAN_STATUS.READY_FOR_CAPABILITY,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '일정 조회 요청으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.ANALYZING,
            text: '캘린더를 확인하고 있어요.',
            mark: 'active',
          },
        ],
        route: {
          kind: 'CALENDAR_READ',
          utterance: text,
          slots: {
            timeframe: /오늘/.test(text) ? 'today' : 'unspecified',
          },
        },
        state: null,
      });
    }

    // SAFETY_TEXT paraphrases
    if (this._isSafetyText(text)) {
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.SAFETY_TEXT,
        status: 'ROUTE_CAPABILITY',
        assistant_text: null,
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.SAFETY_TEXT,
          capability_candidates: ['SAFETY_TEXT_SCAN'],
          risk_boundary: RISK_BOUNDARY.ANALYZE,
          mutate: false,
          status: PLAN_STATUS.READY_FOR_CAPABILITY,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '문자가 걱정된다는 말씀으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.CAUTION,
            text: '위험 신호를 살펴보고 있어요.',
            mark: 'active',
          },
        ],
        route: {
          kind: 'SAFETY_TEXT',
          utterance: text,
        },
        state: null,
      });
    }

    // DOCUMENT_SIMPLIFY paraphrases — plan only / soft answer (no mutate)
    if (this._isDocumentSimplify(text)) {
      return this._result({
        handled: true,
        goal: NATURAL_GOAL.DOCUMENT_SIMPLIFY,
        status: 'ANSWER',
        assistant_text:
          '좋아요. 문서를 쉽게 설명해드릴게요.\n지금은 파일을 바꾸거나 삭제하지 않고, 읽어서 쉬운 말로 풀어주는 계획만 잡아둘게요.\n설명하고 싶은 문서나 문장을 보내주시면 이어갈게요.',
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.DOCUMENT_SIMPLIFY,
          capability_candidates: ['DOCUMENT_SIMPLIFY'],
          missing_slots: ['document_text'],
          risk_boundary: RISK_BOUNDARY.READ,
          mutate: false,
          status: PLAN_STATUS.CLARIFY,
          notes: 'v0.1: dialogue boundary only; no file mutation.',
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.UNDERSTANDING,
            text: '쉬운 설명이 필요하신 것으로 이해했어요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.PLANNING,
            text: '읽기만 하고 쉬운 말로 풀어줄 계획이에요.',
            mark: 'done',
          },
          {
            stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
            text: '설명할 문서나 문장을 기다리고 있어요.',
            mark: 'active',
          },
        ],
        state: null,
      });
    }

    return this._result({
      handled: false,
      goal: null,
      status: null,
      assistant_text: null,
      plan: null,
      progress_seed: [],
      state,
    });
  }

  _isContactMaintenance(text) {
    if (/(연락처|전화번호부|주소록)/.test(text)) {
      return /(정리|합치|중복|청소|정리하|찾아|봐줘|보자)/.test(text);
    }
    return /(중복\s*(번호|연락처)|이름\s*없는\s*(연락처|번호))/.test(
      text
    );
  }

  _isMessageSend(text) {
    if (/(문자|메시지|톡)/.test(text) && /(보내|전송)/.test(text)) {
      return true;
    }
    // "엄마한테 나 늦는다고 좀 알려줘" / "말해놔"
    if (
      /(한테|에게|께)/.test(text) &&
      /(알려줘|알려\s*줘|말해줘|말해놔|전해줘|전해\s*줘)/.test(text)
    ) {
      return true;
    }
    return false;
  }

  _isMessageRead(text) {
    if (!/(문자|메시지|톡|문자함|수신함)/.test(text)) {
      return false;
    }
    if (/(보내|전송|이상|수상|위험|피싱|검사|믿어도)/.test(text)) {
      return false;
    }
    return /(읽|조회|보여|확인|목록|받은\s*문자|최근\s*문자)/.test(text);
  }

  _isCalendarRead(text) {
    if (/(일정|스케줄|캘린더)/.test(text) && /(알려|보여|뭐|있)/.test(text)) {
      return true;
    }
    // "오늘 뭐 있지?"
    if (/오늘/.test(text) && /(뭐\s*있|일정|스케줄)/.test(text)) {
      return true;
    }
    if (/오늘\s*뭐\s*있/.test(text)) return true;
    return false;
  }

  _isSafetyText(text) {
    if (
      /(문자|메시지|톡)/.test(text) &&
      /(이상|수상|위험|피싱|믿어도|검사|봐줘)/.test(text)
    ) {
      return true;
    }
    if (/(피싱\s*아니|믿어도\s*돼)/.test(text)) return true;
    return false;
  }

  _isDocumentSimplify(text) {
    return (
      /(문서|파일|글|내용)/.test(text) &&
      /(무슨\s*말|쉽게|설명|어르신|알아듣)/.test(text)
    ) || /(쉽게\s*좀\s*설명|어르신도\s*알아듣)/.test(text);
  }

  _detectContactMethod(text) {
    if (/(중복|겹치)/.test(text)) return CONTACT_METHOD.DUPLICATES;
    if (/(이름\s*없|미저장|모르는\s*번호)/.test(text)) {
      return CONTACT_METHOD.NO_NAME;
    }
    if (/(오래|안\s*한|잠든|비활성|사용하지\s*않)/.test(text)) {
      return CONTACT_METHOD.INACTIVE;
    }
    return null;
  }

  _continueContact(text, state) {
    if (state.step === 'ASK_METHOD') {
      const method = this._detectContactMethod(text);
      if (!method) {
        return this._result({
          handled: true,
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          status: 'CLARIFY',
          assistant_text:
            '중복 연락처, 이름 없는 번호, 오래된 연락처 중에서 골라 주세요.',
          plan: createDialoguePlan({
            goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
            capability_candidates: ['CONTACT_READ'],
            missing_slots: ['method'],
            risk_boundary: RISK_BOUNDARY.ANALYZE,
            mutate: false,
            status: PLAN_STATUS.CLARIFY,
          }),
          progress_seed: [
            {
              stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
              text: '정리 방식을 확인하고 있어요.',
              mark: 'active',
            },
          ],
          state,
        });
      }
      return this._planContactMethod(method, state);
    }

    if (state.step === 'PLANNED_READ') {
      if (isNeg(text)) {
        return this._result({
          handled: true,
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          status: 'CANCELLED',
          assistant_text:
            '알겠어요. 연락처는 읽지 않을게요. 나중에 다시 말씀해 주세요.',
          plan: createDialoguePlan({
            goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
            status: PLAN_STATUS.CANCELLED,
            mutate: false,
            risk_boundary: RISK_BOUNDARY.ANALYZE,
          }),
          progress_seed: [
            {
              stage: PROGRESS_STAGE.BLOCKED,
              text: '여기서 멈췄어요. 연락처를 읽지 않았어요.',
              mark: 'done',
            },
          ],
          state: null,
        });
      }

      if (isAffirm(text) || /(허용|허락|권한|읽어)/.test(text)) {
        return this._result({
          handled: true,
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          status: 'READY_FOR_CAPABILITY',
          assistant_text: null,
          plan: createDialoguePlan({
            goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
            capability_candidates: ['CONTACT_READ'],
            slots: {
              method: state.method,
              mutate: false,
              op: 'analyze_plan',
            },
            risk_boundary: RISK_BOUNDARY.ANALYZE,
            mutate: false,
            status: PLAN_STATUS.READY_FOR_CAPABILITY,
            notes:
              'User affirmed READ. Propose via runtime; no MERGE/DELETE.',
          }),
          progress_seed: [
            {
              stage: PROGRESS_STAGE.CHECKING_PERMISSION,
              text: '읽기 권한 확인을 받았어요.',
              mark: 'done',
            },
            {
              stage: PROGRESS_STAGE.ANALYZING,
              text: '번호와 이름을 비교하고 있어요.',
              mark: 'active',
            },
            {
              stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
              text: '사용자 확인 전에는 변경하지 않아요.',
              mark: 'pending',
            },
          ],
          state: {
            goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
            step: 'SCAN',
            method: state.method,
            permission_granted: true,
          },
          execute: null,
        });
      }

      return this._result({
        handled: true,
        goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
        status: 'WAITING_PERMISSION',
        assistant_text:
          '연락처를 읽어도 될까요? "응"이라고 하시면 읽기 계획만 확정할게요. 합치거나 삭제는 하지 않아요.',
        plan: createDialoguePlan({
          goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
          capability_candidates: ['CONTACT_READ'],
          slots: { method: state.method, mutate: false },
          risk_boundary: RISK_BOUNDARY.ANALYZE,
          mutate: false,
          status: PLAN_STATUS.WAITING_PERMISSION,
        }),
        progress_seed: [
          {
            stage: PROGRESS_STAGE.CHECKING_PERMISSION,
            text: '필요한 접근 권한을 확인하고 있어요.',
            mark: 'active',
          },
        ],
        state,
      });
    }

    return this._result({
      handled: true,
      goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
      status: 'CLARIFY',
      assistant_text:
        '연락처 정리를 이어가려면 원하시는 방식을 말씀해 주세요.',
      plan: createDialoguePlan({
        goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
        status: PLAN_STATUS.CLARIFY,
        mutate: false,
        risk_boundary: RISK_BOUNDARY.ANALYZE,
      }),
      progress_seed: [
        {
          stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
          text: '다음 안내를 기다리고 있어요.',
          mark: 'active',
        },
      ],
      state,
    });
  }

  _planContactMethod(method, state) {
    const methodLabel =
      method === CONTACT_METHOD.DUPLICATES
        ? '중복 후보'
        : method === CONTACT_METHOD.NO_NAME
          ? '이름 없는 번호'
          : '오래 사용하지 않은 연락처';

    return this._result({
      handled: true,
      goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
      status: 'WAITING_PERMISSION',
      assistant_text:
        '알겠어요.\n먼저 연락처를 읽을 수 있는지 확인하고,\n같은 전화번호나 비슷한 이름을 비교할게요.\n아직 합치거나 삭제하지는 않을게요.',
      plan: createDialoguePlan({
        goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
        capability_candidates: ['CONTACT_READ'],
        slots: {
          method,
          mutate: false,
          op: 'analyze_plan',
        },
        risk_boundary: RISK_BOUNDARY.ANALYZE,
        mutate: false,
        status: PLAN_STATUS.WAITING_PERMISSION,
        notes: 'READ/ANALYZE boundary. No mutate in v0.1.',
      }),
      progress_seed: [
        {
          stage: PROGRESS_STAGE.UNDERSTANDING,
          text: '연락처 정리를 원하는 것으로 이해했어요.',
          mark: 'done',
        },
        {
          stage: PROGRESS_STAGE.PLANNING,
          text: `우선 ${methodLabel}만 찾아볼게요.`,
          mark: 'done',
        },
        {
          stage: PROGRESS_STAGE.CHECKING_PERMISSION,
          text: '연락처 읽기 권한을 확인하고 있어요.',
          mark: 'active',
        },
        {
          stage: PROGRESS_STAGE.ANALYZING,
          text: '전화번호와 이름을 비교할 예정이에요.',
          mark: 'pending',
        },
        {
          stage: PROGRESS_STAGE.WAITING_CONFIRMATION,
          text: '사용자 확인 전에는 변경하지 않아요.',
          mark: 'pending',
        },
      ],
      state: {
        ...state,
        goal: NATURAL_GOAL.CONTACT_MAINTENANCE,
        step: 'PLANNED_READ',
        method,
      },
      execute: null,
    });
  }

  _result(partial) {
    const progress = this.narrator.buildSteps(partial.progress_seed || []);
    const mood = this.narrator.moodFromSteps(progress);

    return clone({
      handled: Boolean(partial.handled),
      goal: partial.goal || null,
      status: partial.status || null,
      assistant_text: partial.assistant_text || null,
      dialogue_plan: partial.plan || null,
      progress,
      character_mood: mood,
      presence_label: this.narrator.moodLabel(mood),
      options: partial.options || null,
      route: partial.route || null,
      prefer_progress_narration: Boolean(
        partial.prefer_progress_narration
      ),
      state: partial.state === undefined ? null : partial.state,
      execute: partial.execute || null,
      /**
       * Hard contract.
       */
      authority_granted: false,
    });
  }
}

module.exports = {
  NaturalConversationEngine,
  NATURAL_GOAL,
  CONTACT_METHOD,
  isAffirm,
  isNeg,
  extractRecipient,
  extractMessageContent,
};
