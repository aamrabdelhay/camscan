'use client';

/**
 * CamScan mark: a stylised book page whose top-right corner is being scanned
 * by a camera aperture. Pure inline SVG (works in the sandboxed preview).
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="10" fill="var(--camscan-text)" />
      <path d="M11 10.5h12.5L29 16v13.5a1.5 1.5 0 0 1-1.5 1.5h-16A1.5 1.5 0 0 1 10 29.5v-17.5A1.5 1.5 0 0 1 11.5 10.5Z"
        fill="none" stroke="var(--camscan-bg)" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M23 10.7V16h5.2" fill="none" stroke="var(--camscan-bg)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.75" />
      <g fill="var(--camscan-bg)" opacity="0.85">
        <rect x="13.5" y="19.5" width="9" height="1.5" rx="0.75" />
        <rect x="13.5" y="23" width="12" height="1.5" rx="0.75" />
        <rect x="13.5" y="26.5" width="6.5" height="1.5" rx="0.75" />
      </g>
      <circle cx="27.4" cy="27.4" r="4.1" fill="var(--color-accent-500)" />
      <circle cx="27.4" cy="27.4" r="1.6" fill="var(--camscan-bg)" />
    </svg>
  );
}
