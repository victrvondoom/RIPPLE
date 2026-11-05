export * from "./format";
export * from "./highlights";
export * from "./Icons";
export { default as FooterColumns, type FooterColumn } from "./FooterColumns";
export { default as Loading } from "./Loading";
export * from "./reviews";
export * from "./search";

// Only the top items are built ahead of time. The rest render on their first visit, so a deploy does not build hundreds of pages.
export const PRERENDERED_ITEMS = 24;
