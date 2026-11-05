import { merchantOf } from "@calhacks/amazon";
import { store } from "./store";

export const merchant = merchantOf(store);
