import { NextResponse, type NextRequest } from "next/server";
import { LruCache } from "@/copiloto/cache/lru";
import { handleCopiloto } from "@/copiloto/http";
import { createClient } from "@/lib/supabase/server";

// Asistente (Nexo Copiloto) integrado en la app: mismo despliegue, sin servicio aparte.
// El usuario se identifica con su sesión de Supabase (cookies) y todo se ejecuta con su JWT.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Un mensaje hace como mucho 2 llamadas a Jev y la redacción; el streaming cabe de sobra.
export const maxDuration = 60;

// Organización de cada usuario (cambia muy rara vez): evita una consulta por mensaje.
// Mismo TTL que la caché de contexto del asistente; el rol se sigue comprobando en cada carga de contexto.
const orgByUser = new LruCache<string>(2000, 5 * 60 * 1000);

async function currentUser() {
  const supabase = await createClient();
  // getClaims verifica el JWT (en local con claves asimétricas; si no, contra Auth) y refresca la sesión si caducó.
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  let orgId = orgByUser.get(userId) ?? null;
  if (!orgId) {
    const { data: membership } = await supabase.from("memberships").select("org_id").eq("user_id", userId).limit(1).maybeSingle();
    orgId = membership?.org_id ?? null;
    if (orgId) orgByUser.set(userId, orgId);
  }
  return { userId, token: session.access_token, orgId };
}

async function handle(request: NextRequest, params: Promise<{ ruta: string[] }>) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ code: "unauthenticated", message: "Inicia sesión para usar el asistente.", retryable: false }, { status: 401 });
  if (!user.orgId) return NextResponse.json({ code: "forbidden", message: "Tu usuario no pertenece a ninguna organización.", retryable: false }, { status: 403 });
  return handleCopiloto((await params).ruta.join("/"), request, { userId: user.userId, token: user.token, orgId: user.orgId });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ ruta: string[] }> }) {
  return handle(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ ruta: string[] }> }) {
  return handle(request, params);
}
