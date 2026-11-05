// Icons both clones draw. They use currentColor, so each store sets the color with CSS.

export function Heart({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 18" aria-hidden>
      <path d="M10 16.5S1.5 11.5 1.5 5.8A4.2 4.2 0 0 1 10 4.3a4.2 4.2 0 0 1 8.5 1.5C18.5 11.5 10 16.5 10 16.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function Camera({ width = 22, height = 20 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 20" aria-hidden>
      <path d="M2 6.5A1.5 1.5 0 0 1 3.5 5h3.2L8.5 2.5h7L17.3 5h3.2A1.5 1.5 0 0 1 22 6.5v10a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 16.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="11.3" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function Chevron({ dir = "down", size = 12 }: { dir?: "down" | "right"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden style={{ transform: dir === "right" ? "rotate(-90deg)" : undefined }}>
      <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
