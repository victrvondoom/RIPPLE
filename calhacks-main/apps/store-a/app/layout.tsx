import type { Metadata } from "next";
import Document from "@calhacks/common/document";
import { store } from "@/lib/store";
import "@calhacks/common/base.css";
import "@calhacks/amazon/styles.css";

export const metadata: Metadata = {
  title: store.title,
  description: "Shop clothing, outerwear, and winter essentials.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <Document>{children}</Document>;
}
