import type { Metadata } from "next";
import { queryOf } from "@calhacks/common";
import { SearchPage } from "@calhacks/amazon";
import { store } from "@/lib/store";

// Results depend on the query in the URL, so this route can wait on its search params.
export const instant = false;

export async function generateMetadata({ searchParams }: PageProps<"/s">): Promise<Metadata> {
  return { title: `${store.brand}: ${queryOf((await searchParams).k)}` };
}

export default async function Page({ searchParams }: PageProps<"/s">) {
  return <SearchPage store={store} query={queryOf((await searchParams).k)} />;
}
