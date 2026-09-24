import { LruCache } from "../cache/lru";
import type { Draft } from "../contract/index";
import type { ConfirmResponse } from "./confirm";
import { DRAFT_TTL_MS } from "./builder";

export type DraftStatus = "pendiente" | "ejecutando" | "confirmado";

export interface StoredDraft {
  draft: Draft;
  orgId: string;
  userId: string;
  messageId: string;
  request: string;
  /** Hasta que no se confirma, el borrador puede usarse una vez. */
  status: DraftStatus;
  idempotencyKey?: string;
  result?: ConfirmResponse;
}

/** Dónde se guardan los borradores entre peticiones (Supabase en producción, con RLS por usuario). */
export interface DraftPersistence {
  insert(entry: StoredDraft): Promise<void>;
  get(draftId: string): Promise<StoredDraft | null>;
  /** pendiente → ejecutando de forma atómica. false si otro clic ya lo tomó. */
  claim(draftId: string): Promise<boolean>;
  finish(draftId: string, status: "pendiente" | "confirmado", result: ConfirmResponse, idempotencyKey: string): Promise<void>;
}

/** Borradores en el servidor: el cliente solo tiene una copia y no puede alterarlos. */
export class DraftStore {
  readonly #memory = new LruCache<StoredDraft>(10_000, DRAFT_TTL_MS);

  constructor(private readonly persistence?: DraftPersistence) {}

  async save(entry: Omit<StoredDraft, "status">): Promise<void> {
    const stored: StoredDraft = { ...entry, status: "pendiente" };
    if (this.persistence) await this.persistence.insert(stored);
    else this.#memory.set(entry.draft.draftId, stored);
  }

  /** Solo devuelve el borrador a su dueño y en su organización. */
  async get(draftId: string, userId: string, orgId: string): Promise<StoredDraft | undefined> {
    const entry = this.persistence ? await this.persistence.get(draftId) : this.#memory.get(draftId);
    return entry && entry.userId === userId && entry.orgId === orgId ? entry : undefined;
  }

  async claim(draftId: string): Promise<boolean> {
    if (this.persistence) return this.persistence.claim(draftId);
    const entry = this.#memory.get(draftId);
    if (!entry || entry.status !== "pendiente") return false;
    entry.status = "ejecutando";
    return true;
  }

  async finish(draftId: string, status: "pendiente" | "confirmado", result: ConfirmResponse, idempotencyKey: string): Promise<void> {
    if (this.persistence) return this.persistence.finish(draftId, status, result, idempotencyKey);
    const entry = this.#memory.get(draftId);
    if (!entry) return;
    entry.status = status;
    if (status === "confirmado") {
      entry.result = result;
      entry.idempotencyKey = idempotencyKey;
    }
  }

  delete(draftId: string): void {
    this.#memory.delete(draftId);
  }
}
