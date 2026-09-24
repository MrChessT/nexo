import type { SessionContext } from "../domain";

export class AuthError extends Error {
  constructor(
    readonly code: "unauthenticated" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthUser {
  userId: string;
  token: string;
}

/** Verifica el JWT de Supabase. Fase 3: verificación con JWKS / auth.getUser. */
export interface AuthPort {
  verify(token: string): Promise<AuthUser>;
}

/** Carga el contexto del usuario (rol, locales, espacios, catálogo) con su JWT. */
export interface ContextPort {
  load(user: AuthUser, orgId: string): Promise<SessionContext>;
}

export function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || null;
}
