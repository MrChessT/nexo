import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  // Destino tras el enlace (p. ej. /cuenta al recuperar la contraseña). Solo rutas internas.
  const next = url.searchParams.get("next");
  // "/\evil.com" o "//evil.com" saldrían a otro dominio: solo "/" seguido de algo que no sea barra.
  const safeNext = next && /^\/(?![\\/])/.test(next) && !next.includes("\\") ? next : "/";
  const target = new URL(safeNext, url.origin);
  return NextResponse.redirect(target.origin === url.origin ? target : new URL("/", url.origin));
}
