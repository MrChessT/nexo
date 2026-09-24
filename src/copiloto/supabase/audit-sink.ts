// Auditoría en la tabla copilot_audit (migración 0005 de la app), con el JWT del usuario: el RLS
// solo permite insertar en su nombre y en organizaciones a las que pertenece.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEvent, AuditSink } from "../audit/audit";

const MAX_MESSAGE = 500;

export function auditRow(event: AuditEvent): Record<string, unknown> {
  const base = { org_id: event.orgId, user_id: event.userId, kind: event.type };
  switch (event.type) {
    case "mensaje":
      return {
        ...base,
        message_id: event.messageId,
        intent: event.intent,
        outcome: event.outcome,
        decisions: event.decisions,
        detail: {
          message: event.message.slice(0, MAX_MESSAGE),
          session_id: event.sessionId,
          jev_model: event.jevModel,
          catalog_version: event.catalogVersion,
          shortcut: event.shortcut,
        },
      };
    case "borrador":
      return { ...base, message_id: event.messageId, draft_id: event.draftId, outcome: event.kind, detail: { coherence: event.coherence } };
    case "confirmacion":
      return { ...base, draft_id: event.draftId, outcome: event.ok ? "ok" : (event.code ?? "error"), detail: { kind: event.kind, ok: event.ok } };
    case "bloqueo":
      return { ...base, message_id: event.messageId, outcome: "bloqueado", detail: { reason: event.reason } };
  }
}

export class SupabaseAuditSink implements AuditSink {
  constructor(private readonly db: SupabaseClient) {}

  async record(event: AuditEvent): Promise<void> {
    const { error } = await this.db.from("copilot_audit").insert(auditRow(event));
    if (error) throw new Error(`copilot_audit: ${error.message}`);
  }
}
