"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import "./login.css";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const supabase = createClient();
      if (!supabase) {
        setMessage("La conexión con Supabase no está configurada.");
        setLoading(false);
        return;
      }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage("No hemos podido iniciar sesión. Revisa tus datos.");
    else router.push("/");
    setLoading(false);
  }

  async function magicLink() {
    if (!email) { setMessage("Escribe tu email para enviarte el enlace."); return; }
    setLoading(true);
    const supabase = createClient();
      if (!supabase) {
        setMessage("La conexión con Supabase no está configurada.");
        setLoading(false);
        return;
      }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
    setMessage(error ? "No hemos podido enviar el enlace." : "Revisa tu email. Te hemos enviado un enlace de acceso.");
    setLoading(false);
  }

  async function resetPassword() {
    if (!email) { setMessage("Escribe tu email y te enviamos un enlace para cambiar la contraseña."); return; }
    setLoading(true);
    const supabase = createClient();
    if (!supabase) {
      setMessage("La conexión con Supabase no está configurada.");
      setLoading(false);
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/cuenta` });
    setMessage(error ? "No hemos podido enviar el enlace. Inténtalo en unos minutos." : "Revisa tu email: el enlace te lleva a tu cuenta para poner una contraseña nueva.");
    setLoading(false);
  }

  return <main className="login-page"><div className="login-art"><div className="login-brand"><span className="login-mark"><Sparkles size={18} /></span><strong>nexo<span>.</span></strong></div><div className="art-copy"><p>Inventario claro.<br /><em>Decisiones rápidas.</em></p><span>Todo tu equipo, todos tus locales, en el mismo pulso.</span></div><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /></div><section className="login-form-wrap"><div className="login-form-box"><div className="mobile-login-brand"><span className="login-mark"><Sparkles size={18} /></span><strong>nexo<span>.</span></strong></div><p className="login-kicker">Bienvenido de nuevo</p><h1>Tu inventario,<br /><span>en orden.</span></h1><p className="login-subtitle">Accede al espacio de trabajo de tu equipo.</p><form onSubmit={submit}><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="tu@email.com" required /><Mail size={16} /></label><label>Contraseña<div className="password-wrap"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label><div className="login-options"><span /><button type="button" className="forgot-button" onClick={resetPassword} disabled={loading}>¿Has olvidado la contraseña?</button></div>{message && <p className="login-message">{message}</p>}<button className="login-submit" disabled={loading}>{loading ? "Accediendo..." : "Entrar al espacio"}<ArrowRight size={17} /></button></form><div className="login-divider"><span>o entra sin contraseña</span></div><button className="magic-button" onClick={magicLink} disabled={loading}><LockKeyhole size={16} /> Enviarme un enlace mágico</button><p className="login-legal">Al continuar aceptas los términos de uso y la política de privacidad.</p></div></section></main>;
}
