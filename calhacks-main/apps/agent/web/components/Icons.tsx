import type { ReactNode, SVGProps } from "react";

// Outline icons on a 16px grid.
function Icon({ size = 14, children, ...props }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PenIcon = () => (
  <Icon strokeWidth={1.5}>
    <path d="M13 9v3.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-8A1.5 1.5 0 0 1 3.5 3H7" />
    <path d="M11.5 2.2a1.2 1.2 0 0 1 1.7 1.7L8 9.1 6 9.6l.5-2z" />
  </Icon>
);

export const ReceiptIcon = () => (
  <Icon>
    <path d="M3.5 1.8h9v12.4l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1z" />
    <path d="M6 5.5h4M6 8h4" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11A1.5 1.5 0 0 1 2.5 9.5z" />
  </Icon>
);

export const BoltIcon = () => (
  <Icon>
    <path d="M9 1.8 3.5 9h4l-.5 5.2L12.5 7h-4z" />
  </Icon>
);

export const WalletIcon = () => (
  <Icon>
    <rect x="2" y="4.5" width="12" height="9" rx="1.5" />
    <path d="M4 4.5 10.6 2.6a1 1 0 0 1 1.3 1v.9" />
    <path d="M14 7.5h-2.5a1.25 1.25 0 0 0 0 2.5H14" />
  </Icon>
);

export const SendIcon = () => (
  <Icon size={12} strokeWidth={1.6}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon size={12} strokeWidth={1.5}>
    <path d="m4.5 6 3.5 3.5L11.5 6" />
  </Icon>
);

export const CheckIcon = ({ size = 10 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);

export const ArrowUpRightIcon = () => (
  <Icon size={12} strokeWidth={1.6}>
    <path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6" />
  </Icon>
);

// A picture frame with a slash: no photo to show.
export const NoImageIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="m4.5 11 2.5-2.5 1.5 1.5 1.5-1.5 1.5 1.5M2 14 14 2" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon size={13}>
    <path d="M3 4.5h10M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
  </Icon>
);
