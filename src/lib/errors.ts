const rpcMessages: Record<string, string> = {
  unauthenticated: "Tu sesión ha caducado. Vuelve a iniciar sesión.",
  forbidden: "No tienes permisos para realizar esta acción.",
  not_found: "No hemos encontrado el documento solicitado.",
  invalid_status: "El documento ya no está en un estado editable.",
  empty_transfer: "Añade al menos un producto al traspaso.",
  empty_receipt: "Añade al menos una línea al albarán.",
  type_not_allowed: "Este tipo de movimiento no está disponible aquí.",
  invalid_quantity: "La cantidad recibida no puede ser negativa ni superar la cantidad enviada.",
  cross_organization_link: "Los datos pertenecen a otra organización.",
  cross_location_link: "La zona no pertenece al local seleccionado.",
};

export function rpcErrorMessage(code?: string | null): string {
  return (code && rpcMessages[code]) || "No se ha podido completar la operación. Inténtalo de nuevo.";
}
