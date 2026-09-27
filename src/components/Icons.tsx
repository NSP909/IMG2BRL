import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const PlayIcon = () => (
  <svg {...base}>
    <path d="M4.5 3.2v9.6l8-4.8z" fill="currentColor" stroke="none" />
  </svg>
);
export const PauseIcon = () => (
  <svg {...base}>
    <rect x="3.5" y="3" width="3.2" height="10" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="9.3" y="3" width="3.2" height="10" rx="0.8" fill="currentColor" stroke="none" />
  </svg>
);
export const PrevIcon = () => (
  <svg {...base}>
    <path d="M12 3.5v9L5.5 8z" fill="currentColor" stroke="none" />
    <path d="M3.5 3.5v9" />
  </svg>
);
export const NextIcon = () => (
  <svg {...base}>
    <path d="M4 3.5v9L10.5 8z" fill="currentColor" stroke="none" />
    <path d="M12.5 3.5v9" />
  </svg>
);
export const RestartIcon = () => (
  <svg {...base}>
    <path d="M3 8a5 5 0 1 0 1.6-3.7" />
    <path d="M3 2.8v2.7h2.7" />
  </svg>
);
export const CameraIcon = () => (
  <svg {...base}>
    <path d="M2.5 5.5h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7h-11z" />
    <circle cx="8" cy="8.8" r="2.2" />
  </svg>
);
export const ScanIcon = () => (
  <svg {...base}>
    <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    <path d="M4 8h8" />
  </svg>
);
export const SendIcon = () => (
  <svg {...base}>
    <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
  </svg>
);

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
