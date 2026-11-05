import type { ReactNode } from "react";
import type { BaseReview } from "@calhacks/common";

export type Review = BaseReview & {
  rating: number;
  title: string;
  helpful: number;
};

// The ID is the ASIN, the same one in the real listing's URL.
export type Item = {
  id: string;
  title: string;
  brand: string;
  category: string;
  image: string;
  images: string[];
  price: number;
  listPrice?: number;
  condition: string;
  rating: number;
  ratingCount: number;
  breakdown: [number, number, number, number, number];
  boughtLastMonth?: string;
  bullets: string[];
  soldBy: string;
  stock: number;
  reviews: Review[];
};

// One config drives the whole storefront, so the real and scam stores share every component.
// Both sell the scraped Amazon listings. The scam store rewrites each one with adapt.
export type Store = {
  title: string;
  brand: string;
  company: string;
  adapt?: (item: Item) => Item;
  deliverTo: string;
  // Delivery estimates are days from today. Two numbers make a range, like "Nov 12 - Dec 3".
  deliveryDays: number[];
  fastDays: number[];
  banner?: ReactNode;
  navHighlight?: string;
  home: {
    kicker: string;
    headline: (lowestPrice: string) => string;
    cta: string;
    tile: (category: string) => string;
    dealLabels: ReactNode[];
  };
  listing: {
    badge?: ReactNode;
    deliveryNote: ReactNode;
    leadBullet?: string;
    hiddenNote?: string;
    urgency?: string;
    shipsFrom: string;
    returns: string;
    payment: string;
    storeLabel: string;
  };
};
