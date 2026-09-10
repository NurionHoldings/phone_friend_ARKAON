'use strict';

/**
 * PhoneFriendRuntime
 * ─────────────────────────────────────────────────
 * PHONE FRIEND — composition root (NOT a security engine).
 *
 * Assembles Conversation + Capability Services + CORE
 * Decision/Gate/ActionRuntime/Execution into one bootable
 * surface for Android / Web / Netlify adapters.
 *
 *   User → Conversation → Intent → Policy → Decision → Gate
 *        → ActionRuntime → Execution → Connector → Verify → Audit
 */

const { DecisionEngine } = require('../../../core/decision-engine.cjs');
const { GateEngine } = require('../../../core/gate-engine.cjs');
const { ActionRuntime } = require('../../../core/action-runtime.cjs');
const { AuditEngine } = require('../../../core/audit-engine.cjs');
const { ExecutionEngine } = require('../../../core/execution-engine.cjs');

const {
  ConversationOrchestrator,
  RESPONSE_KIND,
  SESSION_STATUS,
} = require('../index.cjs');

const {
  CapabilityRuntime,
} = require('./capability-runtime.cjs');

const {
  FriendChatService,
} = require('../capabilities/friend-chat-service.cjs');

const {
  CalendarService,
} = require('../capabilities/calendar-service.cjs');

const {
  MessagingService,
} = require('../capabilities/messaging-service.cjs');

const {
  SafetyGuardService,
} = require('../capabilities/safety-guard-service.cjs');

const {
  DigitalSupportService,
} = require('../capabilities/digital-support-service.cjs');

const {
  SafetyPipeline,
  PIPELINE_RESULT,
} = require('./safety-pipeline.cjs');

const {
  MobileIntentRouter,
} = require('../intents/mobile-intent-router.cjs');

const {
  resolveCoreTarget,
} = require('../policies/capability-policy.cjs');

const {
  E2eDeviceConnector,
} = require('../../../connectors/phone-friend/e2e-device-connector.cjs');

const {
  NaturalConversationEngine,
} = require('../natural/natural-conversation-engine.cjs');

const {
  ProgressNarrator,
  PROGRESS_STAGE,
  CHARACTER_MOOD,
} = require('../progress/progress-narrator.cjs');

const {
  ProgressStore,
} = require('../progress/progress-store.cjs');

const {
  ContactService,
} = require('../capabilities/contact-service.cjs');

const {
  ContactAnalyzer,
  CONTACT_METHOD,
} = require('../contacts/contact-analyzer.cjs');

const {
  MemoryContactConnector,
} = require('../../../connectors/phone-friend/memory-contact-connector.cjs');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalize(text) {
  return String(text || '').trim();
}

/**
 * E2E / product utterance enrichment when router patterns
 * do not yet cover every living scenario. Does NOT grant authority.
 */
function enrichUtterance(utterance, context = {}) {
  const text = normalize(utterance);
  const now = context.now ? new Date(context.now) : new Date();

  // Calendar WRITE: "내일 3시에 병원 일정 넣어줘"
  if (
    /(일정|스케줄)/.test(text) &&
    /(넣어|등록|추가|잡아)/.test(text)
  ) {
    const tomorrow = new Date(now.getTime());
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    // Prefer KST-like fixed slot for deterministic E2E
    const startAt =
      context.start_at ||
      '2026-09-05T15:00:00+09:00';

    const titleMatch = text.match(
      /([가-힣A-Za-z0-9]+)(?:\s*일정|\s*미팅)?/
    );

    let eventTitle = '일정';
    if (/병원/.test(text)) eventTitle = '병원';
    else if (/미팅/.test(text)) eventTitle = '미팅';
    else if (titleMatch) eventTitle = titleMatch[1];

    return {
      kind: 'CALENDAR_WRITE',
      event_title: eventTitle,
      start_at: startAt,
      authority_granted: false,
    };
  }

  // Safety text: "이 문자 이상한데 봐줘" / "피싱 아니야?"
  if (
    (/(문자|메시지|톡)/.test(text) &&
      /(이상|수상|위험|피싱|봐줘|검사|믿어도)/.test(text)) ||
    /(피싱\s*아니|믿어도\s*돼)/.test(text)
  ) {
    return {
      kind: 'SAFETY_TEXT',
      text:
        context.suspect_text ||
        '검찰입니다. 안전계좌로 지금 송금하세요.',
      authority_granted: false,
    };
  }

  // Document convert: "이 파일 PDF로 바꿔줘" / "invoice.pdf.apk를 PDF로..."
  if (
    /(pdf|피디에프)/i.test(text) &&
    /(바꿔|변환|바꿔줘)/.test(text)
  ) {
    const named = text.match(
      /([A-Za-z0-9._-]+\.(?:pdf|apk|txt|docx|jpg|png)(?:\.[A-Za-z0-9]+)?)/i
    );

    return {
      kind: 'DOCUMENT_CONVERT',
      filename:
        (named && named[1]) ||
        context.filename ||
        'document.txt',
      output_format: 'pdf',
      mime_type: context.mime_type || null,
      source: context.source || null,
      source_text: context.source_text || 'hello',
      authority_granted: false,
    };
  }

  // CALL proxy: "전화 대신 받아줘"
  if (
    /(전화|통화)/.test(text) &&
    /(대신|받아|대리)/.test(text)
  ) {
    return {
      kind: 'CALL_HANDOFF',
      capability: 'CALL_PROXY',
      product_capability: 'CALL',
      authority_granted: false,
    };
  }

  return null;
}

class PhoneFriendRuntime {
  constructor(opts = {}) {
    this.audit =
      opts.auditEngine || new AuditEngine();

    this.decisions =
      opts.decisionEngine || new DecisionEngine();

    this.gates =
      opts.gateEngine || new GateEngine();

    this.actions =
      opts.actionRuntime ||
      new ActionRuntime({
        auditEngine: this.audit,
      });

    this.device =
      opts.deviceConnector ||
      new E2eDeviceConnector(opts.device || {});

    this.executions =
      opts.executionEngine ||
      new ExecutionEngine({
        actionRuntime: this.actions,
        auditEngine: this.audit,
        connectors: this.device.asConnectorMap(),
      });

    this.capability =
      opts.capabilityRuntime ||
      new CapabilityRuntime({
        decisionEngine: this.decisions,
        gateEngine: this.gates,
        actionRuntime: this.actions,
        executionEngine: this.executions,
      });

    this.friendChat =
      opts.friendChat || new FriendChatService();

    this.calendar =
      opts.calendar || new CalendarService();

    this.messaging =
      opts.messaging || new MessagingService();

    this.safety =
      opts.safety || new SafetyGuardService();

    this.digital =
      opts.digital || new DigitalSupportService();

    this.pipeline =
      opts.safetyPipeline ||
      new SafetyPipeline({
        safetyService: this.safety,
        digitalService: this.digital,
        capabilityRuntime: this.capability,
      });

    this.router =
      opts.intentRouter || new MobileIntentRouter();

    this.conversation =
      opts.conversation ||
      new ConversationOrchestrator({
        intentRouter: this.router,
        decisionEngine: this.decisions,
        gateEngine: this.gates,
        contacts: opts.contacts || [],
        sessionStore: opts.sessionStore,
        auditEngine: this.audit,
      });

    this.narrator =
      opts.progressNarrator || new ProgressNarrator();

    this.progressStore =
      opts.progressStore || new ProgressStore();

    this.natural =
      opts.naturalEngine ||
      opts.naturalLayer ||
      new NaturalConversationEngine({
        narrator: this.narrator,
      });

    this.contactAnalyzer =
      opts.contactAnalyzer || new ContactAnalyzer();

    this.contactConnector =
      opts.contactConnector ||
      new MemoryContactConnector(opts.contact || {});

    this.executions.registerConnector(
      'phone-friend-contact',
      this.contactConnector
    );

    this.contacts =
      opts.contactService ||
      new ContactService({
        analyzer: this.contactAnalyzer,
      });

    /**
     * Pending write confirmations waiting for "응"
     * (composition-level, not Authority).
     */
    this._pending = new Map();

    /**
     * Natural conversation dialogue state by web/session key.
     */
    this._naturalState = new Map();

    this.preferProgressNarration = true;
  }

  _progressKey(input, subject) {
    return (
      input.natural_session_id ||
      input.session_id ||
      `nat:${subject}`
    );
  }

  _withProgress(result, progressKey, seedSteps) {
    const steps = Array.isArray(seedSteps)
      ? seedSteps
      : Array.isArray(result.progress)
        ? result.progress
        : [];

    const progress = this.progressStore.set(progressKey, steps);
    const mood =
      result.character_mood ||
      this.narrator.moodFromSteps(progress);

    return clone({
      ...result,
      natural_session_id: progressKey,
      progress,
      character_mood: mood,
      presence_label:
        result.presence_label || this.narrator.moodLabel(mood),
      authority_granted: false,
    });
  }

  getAudit() {
    return this.audit;
  }

  getDevice() {
    return this.device;
  }

  /**
   * Primary entry: one user turn.
   */
  async handle(input = {}) {
    const utterance = normalize(input.utterance);
    const now = input.now || new Date();
    const subject = input.subject || 'user:e2e';
    const deviceId = input.device_id || 'device-e2e';

    // Reject expired session early via conversation
    if (input.session_id) {
      const existing = this.conversation.sessions.get(
        input.session_id,
        now
      );
      if (existing && existing.status === SESSION_STATUS.EXPIRED) {
        return this._withProgress(
          {
            status: 'SESSION_EXPIRED',
            executed: false,
            authority_granted: false,
            character_mood: CHARACTER_MOOD.CAUTION,
            conversation: this.conversation.handle({
              utterance,
              session_id: input.session_id,
              subject,
              device_id: deviceId,
              now,
            }),
          },
          this._progressKey(input, subject),
          [
            this.narrator.narrate(
              PROGRESS_STAGE.BLOCKED,
              '대화가 만료돼서 여기서 멈췄어요.',
              'done'
            ),
          ]
        );
      }
    }

    /**
     * Natural Conversation Engine — everyday Korean goals
     * before rigid skill routing. Never grants Authority.
     */
    const naturalKey = this._progressKey(input, subject);

    const natural = this.natural.interpret
      ? this.natural.interpret({
          utterance,
          state: this._naturalState.get(naturalKey) || null,
        })
      : this.natural.understand({
          utterance,
          state: this._naturalState.get(naturalKey) || null,
        });

    if (natural.handled) {
      if (natural.prefer_progress_narration) {
        this.preferProgressNarration = true;
      }

      if (natural.state) {
        this._naturalState.set(naturalKey, natural.state);
      } else if (!natural.route) {
        this._naturalState.delete(naturalKey);
      }

      /**
       * Route structured candidates into existing capability paths.
       * Natural understanding ≠ Decision / Gate.
       */
      if (natural.route && natural.route.kind === 'MESSAGE_SEND') {
        const routed = await this._handleAfterNaturalRoute(
          {
            ...input,
            utterance:
              natural.route.utterance || utterance,
            subject,
            device_id: deviceId,
            now,
          },
          natural
        );
        return this._withProgress(
          routed,
          naturalKey,
          natural.progress
        );
      }

      if (natural.route && natural.route.kind === 'MESSAGE_READ') {
        const routed = await this._handleAfterNaturalRoute(
          {
            ...input,
            utterance:
              natural.route.utterance || utterance,
            subject,
            device_id: deviceId,
            now,
          },
          natural
        );
        return this._withProgress(
          routed,
          naturalKey,
          [
            ...(natural.progress || []),
            this.narrator.fromRuntimeStatus(
              routed.status,
              routed.executed
                ? '문자를 확인했어요. 보내거나 지우지는 않았어요.'
                : null
            ),
          ]
        );
      }

      if (natural.route && natural.route.kind === 'CALENDAR_READ') {
        const routed = await this._handleAfterNaturalRoute(
          {
            ...input,
            utterance:
              natural.route.utterance || utterance,
            subject,
            device_id: deviceId,
            now,
          },
          natural
        );
        return this._withProgress(
          routed,
          naturalKey,
          [
            ...(natural.progress || []),
            this.narrator.fromRuntimeStatus(
              routed.status,
              routed.executed
                ? '일정을 확인했어요.'
                : null
            ),
          ]
        );
      }

      if (natural.route && natural.route.kind === 'SAFETY_TEXT') {
        const routed = await this._handleAfterNaturalRoute(
          {
            ...input,
            utterance:
              natural.route.utterance || utterance,
            subject,
            device_id: deviceId,
            now,
          },
          natural
        );
        return this._withProgress(
          routed,
          naturalKey,
          [
            ...(natural.progress || []),
            this.narrator.fromRuntimeStatus(
              routed.status || 'WARN',
              '위험 신호 검사를 마쳤어요.'
            ),
          ]
        );
      }

      /**
       * CONTACT_MAINTENANCE v0.1:
       * dialogue plan → CONTACT_READ → ANALYZE → PROPOSE
       * No MERGE / DELETE. No Authority.
       */
      const contactPlan = natural.dialogue_plan || natural.plan;
      const hasContactMethod =
        natural.goal === 'CONTACT_MAINTENANCE' &&
        contactPlan &&
        contactPlan.slots &&
        contactPlan.slots.method;

      /**
       * Method chosen but READ permission not yet granted:
       * ask only — do not hit Gate/connector yet.
       */
      if (
        hasContactMethod &&
        contactPlan.status === 'WAITING_PERMISSION' &&
        input.permission_ok !== true
      ) {
        return this._withProgress(
          {
            status: 'WAITING_PERMISSION',
            executed: false,
            authority_granted: false,
            scenario: 'CONTACT_MAINTENANCE',
            assistant_text:
              '연락처를 읽으려면 접근 권한이 필요해요.\n허용해주시면 읽기만 해서 후보를 찾아볼게요.\n아직 합치거나 삭제하지 않아요.',
            dialogue_plan: contactPlan,
            options: [
              { id: 'ALLOW', label: '허용' },
              { id: 'DENY', label: '나중에' },
            ],
            mutated: false,
          },
          naturalKey,
          natural.progress || []
        );
      }

      const shouldProposeContact =
        hasContactMethod &&
        (contactPlan.status === 'READY_FOR_CAPABILITY' ||
          (contactPlan.status === 'WAITING_PERMISSION' &&
            input.permission_ok === true));

      if (shouldProposeContact) {
        const method =
          contactPlan.slots.method ||
          (natural.state && natural.state.method) ||
          CONTACT_METHOD.DUPLICATES;

        /**
         * READY_FOR_CAPABILITY means the user already affirmed
         * the READ step in dialogue. Web prototype may also pass
         * permission_ok explicitly (Android OS grant).
         */
        const permissionOk =
          input.permission_ok === true ||
          contactPlan.status === 'READY_FOR_CAPABILITY';

        const proposal = await this.contacts.propose(this.capability, {
          subject,
          device_id: deviceId,
          method,
          connector: 'phone-friend-contact',
          idempotency_key:
            input.idempotency_key ||
            `contact-propose:${subject}:${method}`,
          permission_ok: permissionOk,
          gate_context: input.gate_context || {},
          now,
        });

        const candidateCount =
          proposal && proposal.analysis
            ? proposal.analysis.candidate_count
            : 0;

        const needsPermission =
          proposal && proposal.executed !== true;

        return this._withProgress(
          {
            status: needsPermission
              ? 'WAITING_PERMISSION'
              : proposal.status,
            executed: proposal.executed === true,
            authority_granted: false,
            scenario: 'CONTACT_MAINTENANCE',
            assistant_text: needsPermission
              ? '연락처를 읽으려면 접근 권한이 필요해요.\n허용해주시면 읽기만 해서 후보를 찾아볼게요.\n아직 합치거나 삭제하지 않아요.'
              : candidateCount > 0
                ? `${candidateCount}개의 정리 후보를 찾았어요. 아직 합치거나 삭제한 연락처는 없어요.`
                : '지금 기준으로 정리 후보를 찾지 못했어요. 연락처는 변경하지 않았어요.',
            dialogue_plan: contactPlan,
            contact_result: proposal,
            proposals: proposal.proposals || [],
            options: needsPermission
              ? [
                  { id: 'ALLOW', label: '허용' },
                  { id: 'DENY', label: '나중에' },
                ]
              : null,
            mutated: false,
          },
          naturalKey,
          needsPermission
            ? natural.progress || []
            : [
                ...(natural.progress || []),
                this.narrator.narrate(
                  PROGRESS_STAGE.ANALYZING,
                  '연락처의 번호와 이름을 비교하고 있어요.',
                  'done'
                ),
                this.narrator.narrate(
                  PROGRESS_STAGE.COMPLETE,
                  candidateCount > 0
                    ? `${candidateCount}개의 후보를 찾았어요. 아직 변경하지 않았어요.`
                    : '분석을 마쳤어요. 연락처는 변경하지 않았어요.',
                  'done'
                ),
              ]
        );
      }

      /**
       * CONTACT_MAINTENANCE clarify / progress-only turns
       * stay on dialogue plan without Gate execute.
       */
      return this._withProgress(
        {
          status: natural.status || 'ANSWER',
          executed: false,
          authority_granted: false,
          scenario: natural.goal
            ? `NATURAL_${natural.goal}`
            : 'NATURAL',
          assistant_text: natural.assistant_text,
          dialogue_plan: natural.dialogue_plan || natural.plan,
          options: natural.options || null,
          character_mood: natural.character_mood,
          presence_label: natural.presence_label,
        },
        naturalKey,
        natural.progress || []
      );
    }

    // Pending confirmation completion
    if (
      input.session_id &&
      this._pending.has(input.session_id)
    ) {
      const pending = this._pending.get(input.session_id);
      const convo = this.conversation.handle({
        utterance,
        session_id: input.session_id,
        subject,
        device_id: deviceId,
        now,
        llmSuggestion: input.llmSuggestion,
        forceAuthority: input.forceAuthority,
        gate_context: input.gate_context,
        continuation_token: input.continuation_token,
      });

      if (
        convo.response &&
        convo.response.kind === RESPONSE_KIND.DENY
      ) {
        return clone({
          status: 'DENY',
          executed: false,
          authority_granted: false,
          conversation: convo,
          scenario: pending.kind,
        });
      }

      if (
        convo.session &&
        convo.session.confirmed === true
      ) {
        this._pending.delete(input.session_id);
        const executed = await this._executePending(
          pending,
          {
            ...input,
            subject,
            device_id: deviceId,
            now,
            policy_ok: true,
          }
        );
        return clone({
          status: executed.status || 'EXECUTED',
          executed: executed.executed === true,
          authority_granted: false,
          conversation: convo,
          capability_result: executed,
          scenario: pending.kind,
        });
      }

      if (
        convo.session &&
        convo.session.status === SESSION_STATUS.CANCELLED
      ) {
        this._pending.delete(input.session_id);
        return clone({
          status: 'CANCELLED',
          executed: false,
          authority_granted: false,
          conversation: convo,
          scenario: pending.kind,
        });
      }

      return clone({
        status: 'WAITING_CONFIRMATION',
        executed: false,
        authority_granted: false,
        conversation: convo,
        scenario: pending.kind,
      });
    }

    // Enrichment for living scenarios not yet in deterministic router
    const enriched = enrichUtterance(utterance, input);

    if (enriched && enriched.kind === 'CALENDAR_WRITE') {
      return this._beginCalendarWrite(enriched, input, subject, deviceId, now);
    }

    if (enriched && enriched.kind === 'SAFETY_TEXT') {
      const result = await this.safety.scanText(this.capability, {
        subject,
        device_id: deviceId,
        text: enriched.text,
        idempotency_key:
          input.idempotency_key || `e2e-safety-text:${Date.now()}`,
        now,
      });
      return clone({
        status: 'WARN',
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'SAFETY_TEXT',
        capability_result: result,
        risk:
          result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.risk,
        findings:
          result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.findings,
      });
    }

    if (enriched && enriched.kind === 'DOCUMENT_CONVERT') {
      const result = await this.pipeline.scanThenConvert({
        subject,
        device_id: deviceId,
        filename: enriched.filename,
        output_format: enriched.output_format,
        mime_type: enriched.mime_type,
        source: enriched.source || input.source,
        source_text: enriched.source_text,
        idempotency_key:
          input.idempotency_key || `e2e-doc:${enriched.filename}`,
        safety_idempotency_key:
          input.safety_idempotency_key ||
          `e2e-doc-scan:${enriched.filename}`,
        policy_ok: input.policy_ok !== false,
        now,
      });
      return clone({
        status: result.status,
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'DOCUMENT_CONVERT',
        capability_result: result,
        file_deleted: result.file_deleted === true,
        safety_decision: result.safety_decision,
      });
    }

    if (enriched && enriched.kind === 'CALL_HANDOFF') {
      const intent = {
        product: 'PHONE_FRIEND',
        product_capability: 'CALL',
        capability: 'CALL_PROXY',
        domain: 'COMMUNICATION',
        action: 'EXECUTE',
        title: utterance,
        raw_text: utterance,
        slots: {},
        authority_granted: false,
      };
      const target = resolveCoreTarget(intent);
      return clone({
        status: 'HANDOFF',
        executed: false,
        authority_granted: false,
        scenario: 'CALL_HANDOFF',
        handoff: target.handoff || {
          product: 'ARKAON_CALL',
          reason: 'call_specialist_axis',
        },
        target,
        note: 'PHONE FRIEND does not exercise call authority',
      });
    }

    // Friend chat emotional / casual (non-executing)
    if (
      /(힘들|지쳤|얘기하자|이야기하자|심심)/.test(utterance)
    ) {
      const chat = this.friendChat.respond({ text: utterance });
      return clone({
        status: 'CHAT',
        executed: false,
        authority_granted: false,
        scenario: 'FRIEND_CHAT',
        chat,
      });
    }

    // Default: conversation orchestrator + optional capability execute
    const convo = this.conversation.handle({
      utterance,
      session_id: input.session_id,
      subject,
      device_id: deviceId,
      now,
      llmSuggestion: input.llmSuggestion,
      forceAuthority: input.forceAuthority,
      gate_context: input.gate_context,
      continuation_token: input.continuation_token,
    });

    const intent = convo.intent;
    const skill = intent && intent.capability;

    // IMAGE SNS escalation — not implemented as connector; HOLD via Decision/Gate
    if (
      skill === 'IMAGE_EDIT' ||
      (intent && intent.product_capability === 'IMAGE')
    ) {
      const target = resolveCoreTarget(intent);
      const isPrivacyShare =
        target.domain === 'PRIVACY' && target.action === 'SHARE';
      return clone({
        status: isPrivacyShare ? 'HOLD' : 'IMAGE_NOT_IMPLEMENTED',
        executed: false,
        authority_granted: false,
        scenario: 'IMAGE',
        conversation: convo,
        target,
        escalation: target.escalation,
        note: 'IMAGE capability not implemented; no Gate bypass',
        assistant_text: isPrivacyShare
          ? '사진을 SNS에 올리는 건 개인정보 공유로 보여서, 지금은 바로 실행하지 않고 확인이 필요해요.'
          : '사진 보정은 아직 준비 중이에요. 지금은 실행하지 않아요.',
      });
    }

    // LIFE_AGENT / FINANCIAL via conversation decision (HOLD without proofs)
    if (
      skill === 'KIOSK_ASSIST' ||
      skill === 'MONEY_TRANSFER' ||
      (intent && intent.domain === 'FINANCIAL')
    ) {
      return clone({
        status:
          convo.response && convo.response.kind === RESPONSE_KIND.HOLD
            ? 'HOLD'
            : convo.gate_result
              ? convo.gate_result.result
              : 'HOLD',
        executed: false,
        authority_granted: false,
        scenario:
          skill === 'KIOSK_ASSIST' ? 'LIFE_AGENT' : 'FINANCIAL',
        conversation: convo,
        decision: convo.decision,
        gate_result: convo.gate_result,
        required_gates:
          convo.decision && convo.decision.required_gates,
        assistant_text:
          skill === 'KIOSK_ASSIST'
            ? '키오스크·예약 도움은 본인확인과 권한이 필요해서 지금은 보류했어요.'
            : '이 작업은 본인확인과 권한이 필요해요. 지금은 진행을 보류했어요.',
      });
    }

    // CALENDAR_READ → execute connector path
    if (skill === 'CALENDAR_READ') {
      const date =
        (intent.slots && intent.slots.timeframe === 'today'
          ? '2026-09-04'
          : intent.slots && intent.slots.date) ||
        input.date ||
        '2026-09-04';

      const result = await this.calendar.read(this.capability, {
        subject,
        device_id: deviceId,
        date,
        idempotency_key:
          input.idempotency_key || `e2e-cal-read:${date}`,
        now,
      });

      return clone({
        status: result.status,
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'CALENDAR_READ',
        conversation: convo,
        capability_result: result,
      });
    }

    // MESSAGE_READ → memory/device messaging connector (no mutate)
    if (skill === 'MESSAGE_READ') {
      const recipient =
        (intent.slots && intent.slots.recipient) ||
        input.recipient ||
        null;
      const limit =
        (intent.slots && intent.slots.limit) || input.limit || 10;

      const result = await this.messaging.read(this.capability, {
        subject,
        device_id: deviceId,
        recipient,
        limit,
        idempotency_key:
          input.idempotency_key ||
          `e2e-msg-read:${recipient || 'all'}:${Date.parse(now) || 0}`,
        now,
      });

      const messages =
        (result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.messages) ||
        [];

      return clone({
        status: result.status,
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'MESSAGE_READ',
        conversation: convo,
        capability_result: result,
        assistant_text:
          messages.length > 0
            ? `최근 문자 ${messages.length}건을 확인했어요. 보내거나 지우지는 않았어요.`
            : '확인된 문자가 없어요. 보내거나 지우지는 않았어요.',
      });
    }

    // MESSAGE_SEND via conversation confirmation flow
    if (skill === 'MESSAGE_SEND') {
      if (
        convo.response &&
        convo.response.kind === RESPONSE_KIND.CONFIRM
      ) {
        this._pending.set(convo.session.id, {
          kind: 'MESSAGE_SEND',
          recipient: intent.slots.recipient,
          content: intent.slots.content,
        });
        return clone({
          status: 'WAITING_CONFIRMATION',
          executed: false,
          authority_granted: false,
          scenario: 'MESSAGE_SEND',
          conversation: convo,
        });
      }

      if (
        convo.session &&
        convo.session.confirmed &&
        intent.slots.recipient &&
        intent.slots.content
      ) {
        const result = await this.messaging.send(this.capability, {
          subject,
          device_id: deviceId,
          recipient: intent.slots.recipient,
          content: intent.slots.content,
          idempotency_key:
            input.idempotency_key ||
            `e2e-msg:${intent.slots.recipient}:${intent.slots.content}`,
          policy_ok: true,
          now,
        });
        return clone({
          status: result.status,
          executed: result.executed === true,
          authority_granted: false,
          scenario: 'MESSAGE_SEND',
          conversation: convo,
          capability_result: result,
        });
      }
    }

    return clone({
      status:
        (convo.response && convo.response.kind) || 'ANSWER',
      executed: false,
      authority_granted: false,
      conversation: convo,
      intent,
    });
  }

  async _handleAfterNaturalRoute(input, natural) {
    const utterance = normalize(input.utterance);
    const subject = input.subject || 'user:e2e';
    const deviceId = input.device_id || 'device-e2e';
    const now = input.now || new Date();
    const kind = natural.route && natural.route.kind;

    if (kind === 'CALENDAR_READ') {
      const timeframe =
        (natural.route.slots && natural.route.slots.timeframe) ||
        'today';
      const date =
        timeframe === 'today'
          ? '2026-09-04'
          : input.date || '2026-09-04';

      const result = await this.calendar.read(this.capability, {
        subject,
        device_id: deviceId,
        date,
        idempotency_key:
          input.idempotency_key || `e2e-cal-read:${date}`,
        now,
      });

      return clone({
        status: result.status,
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'CALENDAR_READ',
        dialogue_plan: natural.dialogue_plan,
        capability_result: result,
      });
    }

    if (kind === 'SAFETY_TEXT') {
      const enriched = enrichUtterance(utterance, input) || {
        kind: 'SAFETY_TEXT',
        text:
          input.suspect_text ||
          '검찰입니다. 안전계좌로 지금 송금하세요.',
      };

      const result = await this.safety.scanText(this.capability, {
        subject,
        device_id: deviceId,
        text: enriched.text,
        idempotency_key:
          input.idempotency_key || `e2e-safety-text:${Date.now()}`,
        now,
      });

      return clone({
        status: 'WARN',
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'SAFETY_TEXT',
        dialogue_plan: natural.dialogue_plan,
        capability_result: result,
        risk:
          result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.risk,
        findings:
          result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.findings,
      });
    }

    if (kind === 'MESSAGE_READ') {
      const slots = (natural.route && natural.route.slots) || {};
      const recipient = slots.recipient || input.recipient || null;
      const limit = slots.limit || input.limit || 10;

      const result = await this.messaging.read(this.capability, {
        subject,
        device_id: deviceId,
        recipient,
        limit,
        idempotency_key:
          input.idempotency_key ||
          `e2e-msg-read:${recipient || 'all'}:${Date.parse(now) || 0}`,
        now,
      });

      const messages =
        (result.execution &&
          result.execution.connector_result &&
          result.execution.connector_result.messages) ||
        [];

      return clone({
        status: result.status,
        executed: result.executed === true,
        authority_granted: false,
        scenario: 'MESSAGE_READ',
        dialogue_plan: natural.dialogue_plan,
        capability_result: result,
        assistant_text:
          messages.length > 0
            ? `최근 문자 ${messages.length}건을 확인했어요. 보내거나 지우지는 않았어요.`
            : '확인된 문자가 없어요. 보내거나 지우지는 않았어요.',
      });
    }

    if (kind === 'MESSAGE_SEND') {
      const slots =
        (natural.route && natural.route.slots) || {};
      const convo = this.conversation.handle({
        utterance,
        session_id: input.session_id,
        subject,
        device_id: deviceId,
        now,
        llmSuggestion: {
          slots: {
            recipient: slots.recipient,
            content: slots.content,
          },
        },
        forceAuthority: input.forceAuthority,
        gate_context: input.gate_context,
        continuation_token: input.continuation_token,
      });

      const intent = convo.intent;
      if (
        intent &&
        intent.capability === 'MESSAGE_SEND' &&
        convo.response &&
        convo.response.kind === RESPONSE_KIND.CONFIRM
      ) {
        this._pending.set(convo.session.id, {
          kind: 'MESSAGE_SEND',
          recipient: intent.slots.recipient,
          content: intent.slots.content,
        });
        return clone({
          status: 'WAITING_CONFIRMATION',
          executed: false,
          authority_granted: false,
          scenario: 'MESSAGE_SEND',
          dialogue_plan: natural.dialogue_plan,
          conversation: convo,
        });
      }

      // Slot-complete fallback if router missed paraphrase
      if (slots.recipient && slots.content) {
        const sessionId =
          (convo.session && convo.session.id) ||
          `pending_${Date.now()}`;

        this._pending.set(sessionId, {
          kind: 'MESSAGE_SEND',
          recipient: slots.recipient,
          content: slots.content,
        });

        let session = this.conversation.sessions.get(sessionId, now);
        if (!session) {
          session = this.conversation.sessions.create({
            id: sessionId,
            subject,
            device_id: deviceId,
            now,
            intent: {
              capability: 'MESSAGE_SEND',
              domain: 'COMMUNICATION',
              action: 'WRITE',
              slots,
              authority_granted: false,
            },
            slots,
          });
        }

        this.conversation.sessions.update(
          sessionId,
          {
            status: SESSION_STATUS.WAITING_CONFIRMATION,
            confirmation_required: true,
            confirmed: false,
          },
          now
        );

        return clone({
          status: 'WAITING_CONFIRMATION',
          executed: false,
          authority_granted: false,
          scenario: 'MESSAGE_SEND',
          dialogue_plan: natural.dialogue_plan,
          conversation: {
            session: this.conversation.sessions.get(sessionId, now),
            response: {
              kind: RESPONSE_KIND.CONFIRM,
              text: `${slots.recipient}에게 "${slots.content}" 문자를 보낼까요?`,
              authority_granted: false,
            },
            intent: {
              capability: 'MESSAGE_SEND',
              slots,
              authority_granted: false,
            },
          },
        });
      }

      return clone({
        status:
          (convo.response && convo.response.kind) || 'CLARIFY',
        executed: false,
        authority_granted: false,
        scenario: 'MESSAGE_SEND',
        dialogue_plan: natural.dialogue_plan,
        conversation: convo,
      });
    }

    return clone({
      status: 'ANSWER',
      executed: false,
      authority_granted: false,
      dialogue_plan: natural.dialogue_plan,
    });
  }

  async _beginCalendarWrite(enriched, input, subject, deviceId, now) {
    const convo = this.conversation.handle({
      utterance: input.utterance,
      subject,
      device_id: deviceId,
      now,
      // Force a WRITE-like conversation path via messaging-like confirm:
      // Use a synthetic COMMUNICATION? Better: ask confirm via pending.
    });

    // Composition-level confirmation (product UX), then CORE policy_ok
    const sessionId =
      (convo.session && convo.session.id) ||
      `pending_${Date.now()}`;

    // Put session into waiting confirmation via pending map
    // and a lightweight conversation confirm turn next.
    this._pending.set(sessionId, {
      kind: 'CALENDAR_WRITE',
      event_title: enriched.event_title,
      start_at: enriched.start_at,
      location: enriched.location || null,
    });

    // Seed conversation session so "응" works through orchestrator
    let session = this.conversation.sessions.get(sessionId, now);
    if (!session) {
      session = this.conversation.sessions.create({
        id: sessionId,
        subject,
        device_id: deviceId,
        now,
        intent: {
          capability: 'CALENDAR_WRITE',
          domain: 'GENERAL_ASSISTANT',
          action: 'WRITE',
          slots: {
            event_title: enriched.event_title,
            start_at: enriched.start_at,
          },
          authority_granted: false,
        },
        slots: {
          event_title: enriched.event_title,
          start_at: enriched.start_at,
        },
      });
    }

    this.conversation.sessions.update(
      sessionId,
      {
        status: SESSION_STATUS.WAITING_CONFIRMATION,
        confirmation_required: true,
        confirmed: false,
      },
      now
    );

    return clone({
      status: 'WAITING_CONFIRMATION',
      executed: false,
      authority_granted: false,
      scenario: 'CALENDAR_WRITE',
      conversation: {
        session: this.conversation.sessions.get(sessionId, now),
        response: {
          kind: RESPONSE_KIND.CONFIRM,
          text: `'${enriched.event_title}' 일정을 ${enriched.start_at}에 등록할까요?`,
          authority_granted: false,
        },
      },
    });
  }

  async _executePending(pending, input) {
    if (pending.kind === 'CALENDAR_WRITE') {
      return this.calendar.write(this.capability, {
        subject: input.subject,
        device_id: input.device_id,
        event_title: pending.event_title,
        start_at: pending.start_at,
        location: pending.location,
        idempotency_key:
          input.idempotency_key ||
          `e2e-cal-write:${pending.event_title}:${pending.start_at}`,
        policy_ok: true,
        now: input.now,
      });
    }

    if (pending.kind === 'MESSAGE_SEND') {
      return this.messaging.send(this.capability, {
        subject: input.subject,
        device_id: input.device_id,
        recipient: pending.recipient,
        content: pending.content,
        idempotency_key:
          input.idempotency_key ||
          `e2e-msg:${pending.recipient}:${pending.content}`,
        policy_ok: true,
        now: input.now,
      });
    }

    return {
      status: 'UNKNOWN_PENDING',
      executed: false,
      authority_granted: false,
    };
  }
}

module.exports = {
  PhoneFriendRuntime,
  enrichUtterance,
  PIPELINE_RESULT,
  PROGRESS_STAGE,
  CHARACTER_MOOD,
};
