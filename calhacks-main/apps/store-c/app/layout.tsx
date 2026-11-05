import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import Document from "@calhacks/common/document";
import "@calhacks/common/base.css";
import "./globals.css";

// Depop uses Aktiv Grotesk Extended, which is not licensed for reuse. Archivo at an expanded width is the closest open font.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "dpp - Buy, Sell, Discover Unique Fashion",
  description: "Buy and sell preloved clothing and outerwear.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <Document fontClass={archivo.variable}>{children}</Document>;
}
