import { Figtree } from "next/font/google";

// Amazon Ember and eBay's Market Sans are not licensed for reuse. Figtree is the closest open font to both, so it is the default.
export const figtree = Figtree({ subsets: ["latin"], variable: "--font-sans" });
