// Hunter's mark: four corner brackets locking focus on a center cross, like a camera finding its subject.
export function Logo({ size = 16, strokeWidth = 1.6, className }: { size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5.5V3a1 1 0 0 1 1-1h2.5" />
      <path d="M10.5 2H13a1 1 0 0 1 1 1v2.5" />
      <path d="M14 10.5V13a1 1 0 0 1-1 1h-2.5" />
      <path d="M5.5 14H3a1 1 0 0 1-1-1v-2.5" />
      <path d="M8 6.4v3.2M6.4 8h3.2" />
    </svg>
  );
}
