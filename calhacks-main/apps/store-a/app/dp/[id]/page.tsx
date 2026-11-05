import { ItemPage, itemMetadata, itemParams } from "@calhacks/amazon";
import { store } from "@/lib/store";

// The top item pages are built ahead of time and the rest render on request, so this route can wait on its params.
export const instant = false;

export function generateStaticParams() {
  return itemParams(store);
}

export async function generateMetadata({ params }: PageProps<"/dp/[id]">) {
  return itemMetadata(store, (await params).id);
}

export default async function Page({ params }: PageProps<"/dp/[id]">) {
  return <ItemPage store={store} id={(await params).id} />;
}
