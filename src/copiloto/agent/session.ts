import { LruCache } from "../cache/lru";
import type { AppRoute, ClarifyField } from "../contract/index";
import type { Product } from "../domain";
import type { JevResult } from "../jev/client";
import type { RoutingMeta } from "./routing";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface PendingClarify {
  clarifyId: string;
  field: ClarifyField;
  /** Índice de segmento cuando field === "producto". */
  segmentIndex?: number;
  optionIds: string[];
  /** Texto de cada opción (mismo orden que optionIds), para reconocerla si el usuario la escribe. */
  optionLabels?: string[];
  /** La pregunta pedía repetir la orden: lo que se escriba es un mensaje nuevo. */
  restart?: boolean;
  message: string;
  page: AppRoute;
  pageContext?: { locationId?: string; areaId?: string };
  /** Resultado de la llamada nº 1 que se reutiliza al responder (no se vuelve a llamar a Jev). */
  routing?: { meta: RoutingMeta; jev: JevResult };
  /** La aclaración viene de un atajo ("/stock ron"): se resuelve sin Jev. */
  fromShortcut?: boolean;
  /** Respuestas ya dadas a aclaraciones anteriores del mismo mensaje. */
  overrides: Record<string, string>;
}

/**
 * De qué va la conversación: lo último consultado o propuesto. Si el siguiente mensaje continúa
 * («¿y en el Vivero?», «¿y la semana pasada?»), se hereda lo que ese mensaje no diga.
 */
export interface Focus {
  kind: "consulta" | "borrador";
  /** Consulta (herramienta) o acción del último mensaje. */
  tool?: string;
  accion?: string;
  /** Solo locales y productos que el usuario llegó a indicar (no los supuestos por defecto). */
  locationIds: string[];
  productIds: string[];
  periodo: string;
  /** Borrador pendiente de confirmar (para «sí, adelante» o «cancélalo»). */
  draftId?: string;
  draftTitle?: string;
  /** Epoch ms: el foco caduca (ver FOCUS_TTL_MS). */
  at: number;
}

/** Pasado este tiempo sin hablar, lo anterior ya no se da por supuesto. */
export const FOCUS_TTL_MS = 30 * 60 * 1000;

export function activeFocus(session: Session, now: number): Focus | undefined {
  return session.focus && now - session.focus.at <= FOCUS_TTL_MS ? session.focus : undefined;
}

export interface Session {
  userId: string;
  turns: Turn[];
  clarifies: Map<string, PendingClarify>;
  focus?: Focus;
}

/** Forma JSON de una sesión (los Map se guardan como pares). */
export interface SerializedSession {
  userId: string;
  turns: Turn[];
  focus?: Focus;
  clarifies: Array<[string, SerializedClarify]>;
}

type SerializedClarify = Omit<PendingClarify, "routing"> & {
  routing?: {
    jev: JevResult;
    meta: {
      segments: Array<{ segment: RoutingMeta["segments"][number]["segment"]; candidates: Array<[string, Product]>; scores: Array<[string, number]> }>;
      locationKeys: Array<[string, string]>;
      areaKeys: Array<[string, string]>;
      message?: string;
    };
  };
};

/** Dónde se guardan las sesiones entre peticiones (Supabase en producción). */
export interface SessionPersistence {
  load(sessionId: string): Promise<SerializedSession | null>;
  save(sessionId: string, orgId: string, session: SerializedSession): Promise<void>;
}

const MAX_TURNS = 6;
const MAX_CLARIFIES = 5;
const TTL_MS = 2 * 60 * 60 * 1000;

export function serializeSession(session: Session): SerializedSession {
  return {
    userId: session.userId,
    turns: session.turns,
    ...(session.focus ? { focus: session.focus } : {}),
    clarifies: [...session.clarifies.entries()].map(([id, c]) => {
      const { routing, ...rest } = c;
      if (!routing) return [id, rest];
      return [
        id,
        {
          ...rest,
          routing: {
            jev: routing.jev,
            meta: {
              segments: routing.meta.segments.map((s) => ({ segment: s.segment, candidates: [...s.candidates.entries()], scores: [...s.scores.entries()] })),
              locationKeys: [...routing.meta.locationKeys.entries()],
              areaKeys: [...routing.meta.areaKeys.entries()],
              ...(routing.meta.message !== undefined ? { message: routing.meta.message } : {}),
            },
          },
        },
      ];
    }),
  };
}

export function deserializeSession(data: SerializedSession): Session {
  return {
    userId: data.userId,
    turns: data.turns ?? [],
    ...(data.focus ? { focus: data.focus } : {}),
    clarifies: new Map(
      (data.clarifies ?? []).map(([id, c]) => {
        const { routing, ...rest } = c;
        if (!routing) return [id, rest as PendingClarify];
        return [
          id,
          {
            ...rest,
            routing: {
              jev: routing.jev,
              meta: {
                segments: routing.meta.segments.map((s) => ({ segment: s.segment, candidates: new Map(s.candidates), scores: new Map(s.scores) })),
                locationKeys: new Map(routing.meta.locationKeys),
                areaKeys: new Map(routing.meta.areaKeys),
                ...(routing.meta.message !== undefined ? { message: routing.meta.message } : {}),
              },
            },
          } as PendingClarify,
        ];
      }),
    ),
  };
}

/** Caché compartida entre peticiones de la misma instancia. */
const sharedCache = new LruCache<Session>(5000, TTL_MS);

export class SessionStore {
  constructor(
    private readonly persistence?: SessionPersistence,
    private readonly cache: LruCache<Session> = sharedCache,
  ) {}

  /** Devuelve la sesión solo si pertenece al usuario; si no, empieza una nueva (evita secuestro de sesión). */
  async get(sessionId: string, userId: string): Promise<Session> {
    const cached = this.cache.get(sessionId);
    if (cached && cached.userId === userId) return cached;
    const stored = await this.persistence?.load(sessionId).catch(() => null);
    if (stored && stored.userId === userId) {
      const session = deserializeSession(stored);
      this.cache.set(sessionId, session);
      return session;
    }
    return { userId, turns: [], clarifies: new Map() };
  }

  async save(sessionId: string, orgId: string, session: Session): Promise<void> {
    this.cache.set(sessionId, session);
    await this.persistence?.save(sessionId, orgId, serializeSession(session));
  }

  addTurn(session: Session, turn: Turn): void {
    session.turns.push({ role: turn.role, text: turn.text.slice(0, 280) });
    if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
  }

  addClarify(session: Session, pending: PendingClarify): void {
    session.clarifies.set(pending.clarifyId, pending);
    while (session.clarifies.size > MAX_CLARIFIES) {
      const oldest = session.clarifies.keys().next().value;
      if (oldest === undefined) break;
      session.clarifies.delete(oldest);
    }
  }
}
