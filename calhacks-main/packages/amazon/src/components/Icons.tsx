// Icons only the Amazon clone draws. Shared icons come from @calhacks/common.

export function Pin({ size = 15, color = "#fff" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={(size * 18) / 15} viewBox="0 0 15 18" aria-hidden>
      <path d="M7.5 1A5.5 5.5 0 0 0 2 6.5C2 10.6 7.5 17 7.5 17S13 10.6 13 6.5A5.5 5.5 0 0 0 7.5 1Z" fill="none" stroke={color} strokeWidth="1.7" />
      <circle cx="7.5" cy="6.5" r="2" fill="none" stroke={color} strokeWidth="1.7" />
    </svg>
  );
}

export function Search() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <circle cx="10" cy="10" r="7" fill="none" stroke="#0f1111" strokeWidth="2.4" />
      <path d="M15.2 15.2 21 21" stroke="#0f1111" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function Cart() {
  return (
    <svg width="38" height="26" viewBox="0 0 38 26" aria-hidden>
      <path d="M1 2h5l4.5 15h17L31 7H10" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round" />
      <circle cx="13" cy="22.5" r="2.3" fill="#fff" />
      <circle cx="25" cy="22.5" r="2.3" fill="#fff" />
    </svg>
  );
}

export function Menu() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden>
      <path d="M1 2h18M1 8h18M1 14h18" stroke="#fff" strokeWidth="2.2" />
    </svg>
  );
}

export function Share() {
  return (
    <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden>
      <path d="M9 13V2M5 6l4-4 4 4M3 9v9h12V9" fill="none" stroke="#0f1111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Flag() {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
      <path d="M2 15V1.5h9l-2 3.5 2 3.5H2" fill="none" stroke="#0f1111" strokeWidth="1.6" />
    </svg>
  );
}

export function Avatar() {
  return (
    <svg viewBox="0 0 34 34" width="34" height="34" aria-hidden>
      <circle cx="17" cy="17" r="17" fill="#d5d9d9" />
      <circle cx="17" cy="13" r="6" fill="#fff" />
      <path d="M6 29c2-6 7-8 11-8s9 2 11 8" fill="#fff" />
    </svg>
  );
}
