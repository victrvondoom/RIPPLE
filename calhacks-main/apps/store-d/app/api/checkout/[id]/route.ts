import { checkoutRoute } from "@calhacks/common/x402";
import { merchant } from "@/lib/merchant";

export const POST = checkoutRoute(merchant);
