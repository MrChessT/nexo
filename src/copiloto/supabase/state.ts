// Estado del asistente en Supabase (migración 0006): sesiones y borradores, con el JWT del usuario.
// En Vercel cada petición puede ir a otra instancia; la memoria solo es una caché.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Habits, HabitsPersistence } from "../agent/habits";
import type { SerializedSession, SessionPersistence } from "../agent/session";
import type { ConfirmResponse } from "../drafts/confirm";
import type { DraftPersistence, StoredDraft } from "../drafts/store";
import { DataError } from "./client";

export class SupabaseSessionPersistence implements SessionPersistence {
  constructor(private readonly db: SupabaseClient) {}

  async load(sessionId: string): Promise<SerializedSession | null> {
    const { data, error } = await this.db.from("copilot_sessions").select("state").eq("id", sessionId).maybeSingle();
    if (error) throw new DataError("No se pudo leer la sesión del asistente", { cause: error });
    return (data?.state as SerializedSession | undefined) ?? null;
  }

  async save(sessionId: string, orgId: string, session: SerializedSession): Promise<void> {
    const { error } = await this.db
      .from("copilot_sessions")
      .upsert({ id: sessionId, org_id: orgId, user_id: session.userId, state: session, updated_at: new Date().toISOString() });
    if (error) throw new DataError("No se pudo guardar la sesión del asistente", { cause: error });
  }
}

export class SupabaseHabitsPersistence implements HabitsPersistence {
  constructor(private readonly db: SupabaseClient) {}

  async load(orgId: string, userId: string): Promise<Habits | null> {
    const { data, error } = await this.db.from("copilot_profiles").select("habits").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    if (error || !data) return null;
    const habits = data.habits as Partial<Habits>;
    return { locations: habits.locations ?? {}, products: habits.products ?? {} };
  }

  async save(orgId: string, userId: string, habits: Habits): Promise<void> {
    await this.db.from("copilot_profiles").upsert({ org_id: orgId, user_id: userId, habits, updated_at: new Date().toISOString() });
  }
}

interface DraftRow {
  id: string;
  user_id: string;
  org_id: string;
  message_id: string | null;
  request: string | null;
  draft: StoredDraft["draft"];
  status: StoredDraft["status"];
  idempotency_key: string | null;
  result: ConfirmResponse | null;
}

export class SupabaseDraftPersistence implements DraftPersistence {
  constructor(private readonly db: SupabaseClient) {}

  async insert(entry: StoredDraft): Promise<void> {
    const { error } = await this.db.from("copilot_drafts").insert({
      id: entry.draft.draftId,
      user_id: entry.userId,
      org_id: entry.orgId,
      message_id: entry.messageId,
      request: entry.request.slice(0, 1000),
      draft: entry.draft,
      status: entry.status,
      expires_at: entry.draft.expiresAt,
    });
    if (error) throw new DataError("No se pudo guardar el borrador", { cause: error });
  }

  async get(draftId: string): Promise<StoredDraft | null> {
    const { data, error } = await this.db
      .from("copilot_drafts")
      .select("id,user_id,org_id,message_id,request,draft,status,idempotency_key,result")
      .eq("id", draftId)
      .maybeSingle();
    if (error) throw new DataError("No se pudo leer el borrador", { cause: error });
    if (!data) return null;
    const row = data as DraftRow;
    return {
      draft: row.draft,
      orgId: row.org_id,
      userId: row.user_id,
      messageId: row.message_id ?? "",
      request: row.request ?? "",
      status: row.status,
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.result ? { result: row.result } : {}),
    };
  }

  async claim(draftId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("copilot_drafts")
      .update({ status: "ejecutando" })
      .eq("id", draftId)
      .eq("status", "pendiente")
      .select("id");
    if (error) throw new DataError("No se pudo reservar el borrador", { cause: error });
    return (data ?? []).length === 1;
  }

  async finish(draftId: string, status: "pendiente" | "confirmado", result: ConfirmResponse, idempotencyKey: string): Promise<void> {
    const { error } = await this.db
      .from("copilot_drafts")
      .update(status === "confirmado" ? { status, result, idempotency_key: idempotencyKey } : { status })
      .eq("id", draftId);
    if (error) throw new DataError("No se pudo cerrar el borrador", { cause: error });
  }
}
