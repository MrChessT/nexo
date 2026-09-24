/** Minúsculas y sin acentos. La ñ pasa a n, que para buscar coincidencias da igual. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Palabras que no ayudan a identificar un producto. */
export const STOPWORDS = new Set([
  "a", "al", "algo", "ante", "baja", "bajame", "busca", "cual", "cuales", "cuando", "cuanto", "cuanta", "cuantos",
  "cuantas", "da", "dame", "de", "del", "desde", "el", "ella", "en", "entre", "es", "esta", "este", "esto", "falta",
  "faltan", "hay", "hoy", "la", "las", "le", "lo", "los", "me", "mi", "mis", "muestra", "nos", "o", "para", "pasa",
  "pasame", "por", "porque", "precio", "precios", "que", "queda", "quedan", "quiero", "registra", "se", "si", "sin",
  "stock", "su", "sus", "tenemos", "tengo", "un", "una", "uno", "unos", "unas", "y", "ya", "ver", "dime", "mira",
  "roto", "rota", "rotos", "rotas", "caducado", "caducada", "caducados", "caducadas", "derramado", "derramada",
  "barra", "almacen", "camara", "local", "semana", "mes", "ayer", "finde", "fin", "manda", "envia", "traspasa",
  "recibe", "recibido", "recibidas", "recibidos", "llegado", "llegaron", "merma", "mermas", "tira", "tirado",
]);
