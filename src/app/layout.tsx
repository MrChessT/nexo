import type { Metadata } from "next";
import { Copiloto } from "@/components/copiloto/copiloto";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexo | Inventario inteligente",
  description: "Control de stock multilocal para hosteleria",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>
        {children}
        <Copiloto />
      </body>
    </html>
  );
}
