import { HomePage } from "@calhacks/amazon";
import { store } from "@/lib/store";

export default function Home() {
  return <HomePage store={store} />;
}
