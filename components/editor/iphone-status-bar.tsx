import React from "react";

// Fixed preview state, drawn as vectors so Windows font fallback cannot change
// the clock or turn the iOS indicators into generic outline icons.
// The Dynamic Island is already in phone-mockup-frame.png; keep the center empty.
// Visual reference: https://developer.apple.com/design/human-interface-guidelines/status-bars
export function IPhoneStatusBar({ className = "" }: { className?: string }) {
  return <svg className={`mx-iphone-statusBar ${className}`} viewBox="0 0 375 54" fill="currentColor" aria-hidden="true" focusable="false" data-testid="iphone-status-bar">
    <g transform="translate(50 20)" data-part="time-9-41">
      <path fillRule="evenodd" d="M4.88 0C1.99 0 .14 1.95.14 4.55c0 2.49 1.7 4.24 4.14 4.24 1.45 0 2.57-.62 3.16-1.68h.05c-.01 3.25-.98 4.88-2.87 4.88-1.16 0-2.01-.61-2.27-1.63H.22c.3 2.11 2.01 3.48 4.39 3.48 3.24 0 5.09-2.58 5.09-7.07C9.7 2.45 7.89 0 4.88 0Zm0 1.84c1.49 0 2.56 1.15 2.56 2.69 0 1.52-1.09 2.58-2.6 2.58-1.48 0-2.5-1.06-2.5-2.62 0-1.54 1.06-2.65 2.54-2.65Z"/>
      <circle cx="13.24" cy="4.2" r="1.24"/><circle cx="13.24" cy="10.28" r="1.24"/>
      <path fillRule="evenodd" d="M23.42.22h-2.76l-5.83 8.42v1.89h6.45v3.06h2.14v-3.06h1.81V8.66h-1.81V.22Zm-2.16 2.42h.06v6.02h-4.17v-.06l4.11-5.96Z"/>
      <path d="M30.86 13.59h2.19V.22h-2.18l-3.48 2.44v2.12l3.42-2.37h.05v11.18Z"/>
    </g>
    <g transform="translate(268 21.5)" data-part="cellular">
      <rect y="8" width="3.2" height="4" rx=".85"/>
      <rect x="4.8" y="5.5" width="3.2" height="6.5" rx=".85"/>
      <rect x="9.6" y="3" width="3.2" height="9" rx=".85"/>
      <rect x="14.4" width="3.2" height="12" rx=".85"/>
    </g>
    <g transform="translate(291 21.5)" data-part="wifi">
      <path d="M8.5.5C5.27.5 2.35 1.73.14 3.74a.42.42 0 0 0-.01.61l1.09 1.09c.16.16.41.17.58.02a10.1 10.1 0 0 1 13.4 0c.17.15.42.14.58-.02l1.09-1.09a.42.42 0 0 0-.01-.61A12.38 12.38 0 0 0 8.5.5Z"/>
      <path d="M8.5 4.58c-2.1 0-4.01.79-5.46 2.08a.42.42 0 0 0-.02.61l1.1 1.1c.16.16.41.17.58.03a5.85 5.85 0 0 1 7.6 0c.17.14.42.13.58-.03l1.1-1.1a.42.42 0 0 0-.02-.61A8.18 8.18 0 0 0 8.5 4.58Z"/>
      <path d="M8.5 8.7c-.97 0-1.87.33-2.58.88a.4.4 0 0 0-.04.6l2.34 2.34a.4.4 0 0 0 .56 0l2.34-2.34a.4.4 0 0 0-.04-.6A4.18 4.18 0 0 0 8.5 8.7Z"/>
    </g>
    <g transform="translate(314 21.5)" data-part="battery-full">
      <rect x=".5" y=".5" width="24" height="11" rx="3.4" fill="none" stroke="currentColor" strokeOpacity=".38"/>
      <rect x="2" y="2" width="21" height="8" rx="2"/>
      <path d="M26 4v4c1.1-.35 1.65-1.02 1.65-2S27.1 4.35 26 4Z" opacity=".45"/>
    </g>
  </svg>;
}
