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

/** Carga el contexto del usuario (rol, locales, espacios, catálogo) con su JWT. */
export interface ContextPort {
  load(user: AuthUser, orgId: string): Promise<SessionContext>;
}

