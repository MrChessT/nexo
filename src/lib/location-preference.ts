// Local elegido por el usuario, recordado en este navegador y compartido por Resumen, Stock y Pedidos.
// Si no hay almacenamiento (modo privado), simplemente no se recuerda.

const KEY = "nexo.local";

export function readLocation(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveLocation(id: string): void {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Sin almacenamiento: solo se pierde la preferencia.
  }
}
