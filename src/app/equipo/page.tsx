"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, MailPlus, Trash2, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import "../productos/productos.css";
import "../productos/product-editor.css";
import "../proveedores/proveedores.css";
import "./equipo.css";

// Equipo: miembros con su rol y locales, invitaciones pendientes y alta por invitación.
// Solo administradores (org_members y RLS lo exigen también en la base de datos).

type Role = "owner" | "admin" | "manager" | "staff";
type Location = { id: string; name: string };
type Member = { userId: string; email: string; name: string; role: Role; allLocations: boolean; locationIds: string[] };
type Invitation = { id: string; email: string; role: Role; allLocations: boolean; locationIds: string[]; createdAt: string };
type Access = { role: Role; allLocations: boolean; locationIds: string[] };

const ROLE_LABEL: Record<Role, string> = { owner: "Propietario", admin: "Administrador", manager: "Encargado", staff: "Equipo" };
const ROLE_HINT: Record<Role, string> = {
  owner: "Todo, incluido gestionar otros propietarios.",
  admin: "Todo: locales, equipo, catálogo y operaciones.",
  manager: "Catálogo, precios, mínimos, cierres de inventario y envío de traspasos.",
  staff: "Operativa diaria: mermas, recepciones, traspasos en borrador y conteos.",
};

function friendly(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return fallback;
  if (error.message?.includes("last_owner")) return "Tiene que quedar al menos un propietario.";
  if (error.message?.includes("forbidden") || error.code === "42501") return "No tienes permisos para hacer este cambio.";
  if (error.code === "23505") return "Ya hay una invitación pendiente para ese email.";
  return fallback;
}

export default function TeamPage() {
  const [me, setMe] = useState<{ userId: string; orgId: string; role: Role } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [editing, setEditing] = useState<Member | "invite" | null>(null);
  const [notice, setNotice] = useState("");

  async function load() {
    const supabase = createClient();
    if (!supabase) return setState("error");
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user.id;
    const { data: membership } = userId
      ? await supabase.from("memberships").select("org_id, role").eq("user_id", userId).limit(1).maybeSingle()
      : { data: null };
    if (!userId || !membership) return setState("forbidden");
    const role = membership.role as Role;
    setMe({ userId, orgId: membership.org_id, role });
    if (role !== "owner" && role !== "admin") return setState("forbidden");

    const [membersResult, invitationsResult, locationsResult] = await Promise.all([
      supabase.rpc("org_members", { p_org: membership.org_id }),
      supabase.from("invitations").select("id, email, role, all_locations, location_ids, created_at").is("accepted_at", null).order("created_at", { ascending: false }),
      supabase.from("locations").select("id, name").eq("active", true).order("name"),
    ]);
    if (membersResult.error) return setState(membersResult.error.message?.includes("forbidden") ? "forbidden" : "error");
    setMembers(
      (membersResult.data ?? []).map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.full_name?.trim() || m.email.split("@")[0]!,
        role: m.role,
        allLocations: m.all_locations,
        locationIds: m.location_ids ?? [],
      })),
    );
    setInvitations(
      (invitationsResult.data ?? []).map((i) => ({ id: i.id, email: i.email, role: i.role, allLocations: i.all_locations, locationIds: i.location_ids ?? [], createdAt: i.created_at })),
    );
    setLocations((locationsResult.data ?? []) as Location[]);
    setState("ready");
  }

  useEffect(() => {
    async function start() {
      await Promise.resolve();
      await load();
    }
    void start();
  }, []);

  async function cancelInvitation(id: string) {
    const { error } = (await createClient()?.from("invitations").delete().eq("id", id)) ?? { error: null };
    setNotice(error ? friendly(error, "No se pudo cancelar la invitación.") : "Invitación cancelada.");
    await load();
  }

  const scope = (a: { allLocations: boolean; locationIds: string[]; role: Role }) =>
    a.allLocations || a.role === "owner" || a.role === "admin"
      ? "Todos los locales"
      : a.locationIds.map((id) => locations.find((l) => l.id === id)?.name).filter(Boolean).join(", ") || "Ningún local";

  return (
    <main className="catalog-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link"><ArrowLeft size={16} /> Resumen</Link>
        <span className="catalog-title">Equipo</span>
        <span />
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Gestión · Personas</p>
            <h1>Equipo</h1>
            <p className="catalog-subtitle">Quién entra, qué puede hacer y en qué locales.</p>
          </div>
          {state === "ready" && <button className="catalog-primary" onClick={() => setEditing("invite")}><MailPlus size={17} /> Invitar</button>}
        </div>

        {notice && <p className="team-notice">{notice}</p>}
        {state === "loading" && <div className="catalog-empty"><strong>Cargando equipo...</strong></div>}
        {state === "error" && <div className="catalog-empty"><strong>No se pudo cargar el equipo.</strong><button className="filter-button" onClick={() => void load()}>Reintentar</button></div>}
        {state === "forbidden" && (
          <div className="catalog-empty">
            <strong>Solo los administradores gestionan el equipo</strong>
            <span>{me ? `Tu rol es ${ROLE_LABEL[me.role].toLowerCase()}.` : "Aún no perteneces a ninguna organización: pide a un administrador que te invite."}</span>
          </div>
        )}

        {state === "ready" && (
          <>
            <section className="catalog-panel">
              <div className="team-head"><span>Persona</span><span>Rol</span><span>Locales</span></div>
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="team-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditing(m)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditing(m);
                    }
                  }}
                >
                  <span className="catalog-product">
                    <span className="catalog-product-icon"><UserRound size={16} /></span>
                    <span><strong>{m.name}{m.userId === me?.userId ? " (tú)" : ""}</strong><small>{m.email}</small></span>
                  </span>
                  <span className={`role-pill ${m.role}`}>{ROLE_LABEL[m.role]}</span>
                  <span className="cell-ellipsis">{scope(m)}</span>
                </div>
              ))}
            </section>

            {invitations.length > 0 && (
              <section className="catalog-panel">
                <div className="team-head"><span>Invitación pendiente</span><span>Rol</span><span>Locales</span></div>
                {invitations.map((i) => (
                  <div key={i.id} className="team-row static">
                    <span className="catalog-product">
                      <span className="catalog-product-icon pending"><MailPlus size={16} /></span>
                      <span><strong>{i.email}</strong><small>Invitado el {new Date(i.createdAt).toLocaleDateString("es-ES")}</small></span>
                    </span>
                    <span className={`role-pill ${i.role}`}>{ROLE_LABEL[i.role]}</span>
                    <span className="team-actions">
                      <span className="cell-ellipsis">{scope(i)}</span>
                      <button className="icon-danger" aria-label={`Cancelar la invitación de ${i.email}`} onClick={() => void cancelInvitation(i.id)}><Trash2 size={15} /></button>
                    </span>
                  </div>
                ))}
              </section>
            )}
            <p className="section-hint team-help">
              La persona invitada entra en <b>{typeof window === "undefined" ? "" : `${window.location.origin}/login`}</b> con su email y pulsa «Enviarme un enlace mágico». Al entrar, queda unida con el rol y los locales de la invitación.
            </p>
          </>
        )}
      </div>

      {editing && me && (
        <AccessEditor
          member={editing === "invite" ? null : editing}
          me={me}
          ownersCount={members.filter((m) => m.role === "owner").length}
          locations={locations}
          onClose={() => setEditing(null)}
          onDone={(message) => {
            setNotice(message);
            setEditing(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function AccessEditor({
  member,
  me,
  ownersCount,
  locations,
  onClose,
  onDone,
}: {
  member: Member | null;
  me: { userId: string; orgId: string; role: Role };
  ownersCount: number;
  locations: Location[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<Access>(member ? { role: member.role, allLocations: member.allLocations, locationIds: member.locationIds } : { role: "staff", allLocations: false, locationIds: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  const isSelf = member?.userId === me.userId;
  const canTouchOwner = me.role === "owner";
  const lockedOwner = member?.role === "owner" && (!canTouchOwner || ownersCount <= 1);
  const roles: Role[] = canTouchOwner ? ["staff", "manager", "admin", "owner"] : ["staff", "manager", "admin"];
  const fullAccess = access.role === "owner" || access.role === "admin";

  function toggleLocation(id: string) {
    setAccess((a) => ({ ...a, locationIds: a.locationIds.includes(id) ? a.locationIds.filter((x) => x !== id) : [...a.locationIds, id] }));
  }

  async function save() {
    const supabase = createClient();
    if (!supabase) return;
    if (!fullAccess && !access.allLocations && access.locationIds.length === 0) return setError("Elige al menos un local o «Todos los locales».");
    setSaving(true);
    setError("");
    const allLocations = fullAccess || access.allLocations;
    const locationIds = allLocations ? [] : access.locationIds;

    if (!member) {
      const clean = email.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(clean)) {
        setSaving(false);
        return setError("Escribe un email válido.");
      }
      const { error: err } = await supabase.from("invitations").insert({ org_id: me.orgId, email: clean, role: access.role, all_locations: allLocations, location_ids: locationIds });
      setSaving(false);
      if (err) return setError(friendly(err, "No se pudo crear la invitación."));
      return onDone(`Invitación creada para ${clean}.`);
    }

    const { data, error: err } = await supabase
      .from("memberships")
      .update({ role: access.role, all_locations: allLocations })
      .eq("org_id", me.orgId)
      .eq("user_id", member.userId)
      .select("user_id");
    if (err || !data?.length) {
      setSaving(false);
      return setError(friendly(err ?? { code: "42501" }, "No se pudo guardar."));
    }
    // Locales concretos: se reemplaza la lista completa.
    const { error: delError } = await supabase.from("membership_locations").delete().eq("org_id", me.orgId).eq("user_id", member.userId);
    const { error: insError } = locationIds.length
      ? await supabase.from("membership_locations").insert(locationIds.map((locationId) => ({ org_id: me.orgId, user_id: member.userId, location_id: locationId })))
      : { error: null };
    setSaving(false);
    if (delError || insError) return setError(friendly(delError ?? insError, "Se guardó el rol, pero no los locales."));
    onDone(`Acceso de ${member.name} actualizado.`);
  }

  async function remove() {
    if (!member) return;
    const supabase = createClient();
    if (!supabase) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("memberships").delete().eq("org_id", me.orgId).eq("user_id", member.userId).select("user_id");
    setSaving(false);
    setConfirmRemove(false);
    if (err || !data?.length) return setError(friendly(err ?? { code: "42501" }, "No se pudo quitar del equipo."));
    onDone(`${member.name} ya no forma parte del equipo.`);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/login`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-layer editor-layer" onClick={() => !saving && onClose()}>
      <section className="product-editor team-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={member ? "Acceso de la persona" : "Invitar"}>
        <header className="editor-header">
          <div>
            <p className="eyebrow">{member ? member.email : "Nueva invitación"}</p>
            <h2>{member ? member.name : "Invitar al equipo"}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </header>
        <div className="editor-body">
          <div className="editor-grid">
            {!member && (
              <label className="span-2">Email<input autoFocus type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@ejemplo.com" /></label>
            )}
            <div className="span-2 role-options">
              {roles.map((r) => (
                <button type="button" key={r} disabled={lockedOwner} className={`role-option ${access.role === r ? "active" : ""}`} onClick={() => setAccess((a) => ({ ...a, role: r }))}>
                  <b>{ROLE_LABEL[r]}</b>
                  <small>{ROLE_HINT[r]}</small>
                </button>
              ))}
            </div>
            {lockedOwner && <p className="span-2 field-hint">{canTouchOwner ? "Es el único propietario: nombra antes a otro." : "Solo un propietario puede cambiar a otro propietario."}</p>}
            {!fullAccess && (
              <div className="span-2 location-options">
                <label className="location-option">
                  <input type="checkbox" checked={access.allLocations} onChange={(event) => setAccess((a) => ({ ...a, allLocations: event.target.checked }))} /> Todos los locales
                </label>
                {!access.allLocations &&
                  locations.map((l) => (
                    <label key={l.id} className="location-option">
                      <input type="checkbox" checked={access.locationIds.includes(l.id)} onChange={() => toggleLocation(l.id)} /> {l.name}
                    </label>
                  ))}
              </div>
            )}
          </div>
          {!member && (
            <p className="section-hint team-help">
              Cuando la guardes, pásale el enlace de acceso: entra con este email y pulsa «Enviarme un enlace mágico».{" "}
              <button type="button" className="ghost-button" onClick={() => void copyLink()}>{copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar enlace</>}</button>
            </p>
          )}
        </div>
        {error && <p className="editor-message error">{error}</p>}
        <footer className="editor-footer">
          {member && !isSelf && !lockedOwner ? (
            confirmRemove ? (
              <div className="delete-confirm">
                <span>¿Quitar a {member.name} del equipo?</span>
                <button className="danger-button" disabled={saving} onClick={() => void remove()}>Sí, quitar</button>
                <button className="ghost-button" onClick={() => setConfirmRemove(false)}>Cancelar</button>
              </div>
            ) : (
              <button className="ghost-button danger" disabled={saving} onClick={() => setConfirmRemove(true)}><Trash2 size={14} /> Quitar del equipo</button>
            )
          ) : (
            <span />
          )}
          <button className="catalog-primary" disabled={saving || lockedOwner} onClick={() => void save()}>
            {saving ? "Guardando..." : member ? "Guardar cambios" : "Crear invitación"}
          </button>
        </footer>
      </section>
    </div>
  );
}
