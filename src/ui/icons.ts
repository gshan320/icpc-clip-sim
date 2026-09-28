import type { ToolId } from '../state/store';

/** Line icons (24×24, stroke = currentColor) for the instrument toolbar. */
const P: Record<ToolId, string> = {
  suction: '<path d="M5 21v-8a7 7 0 0 1 7-7h8"/><path d="M20 3.5v5"/><path d="M8.5 21h-7"/>',
  scissors: '<circle cx="6.5" cy="18" r="2.6"/><circle cx="17.5" cy="18" r="2.6"/><path d="M8.2 16 15.2 3.5M15.8 16 8.8 3.5"/><circle cx="12" cy="9.6" r=".6"/>',
  bipolar: '<path d="M8.6 21 11.2 5.2M15.4 21 12.8 5.2"/><path d="M11.2 5.2h1.6"/><path d="M9.6 15h4.8"/><path d="M12 1.6v1.4M9.4 2.4l.8 1.1M14.6 2.4l-.8 1.1"/>',
  dissector: '<path d="M17.5 21 9.8 8.4"/><path d="M9.8 8.4c-1-1.7-.4-3.6 1.2-4.3"/><circle cx="12.1" cy="3.8" r="1.3"/>',
  spatula: '<path d="M8.5 21 13.8 5.8a2.3 2.3 0 0 1 4.3 1.5L13 21"/><path d="M9.5 21h4.5"/>',
  clip: '<circle cx="12" cy="16.5" r="3.2"/><path d="M10.8 13.4V2.8M13.2 13.4V2.8"/><path d="M10.8 2.8h2.4"/>',
  icg: '<path d="M1.8 12s3.7-6.2 10.2-6.2S22.2 12 22.2 12s-3.7 6.2-10.2 6.2S1.8 12 1.8 12z"/><circle cx="12" cy="12" r="2.7"/><path d="M12 2v1.6M4.6 4.2l1 1.2M19.4 4.2l-1 1.2"/>',
  doppler: '<path d="M1.5 13h3.2l2-5.5 3 11 3-13.5 3 10.5 1.8-2.5h5"/>',
  endoscope: '<path d="M3.5 20.5 14.6 9.4"/><circle cx="17.3" cy="6.7" r="3.8"/><circle cx="17.3" cy="6.7" r="1.3"/>',
  tempclip: '<path d="M6.8 2.8v7.6a2.6 2.6 0 0 0 5.2 0V2.8"/><circle cx="17" cy="17" r="4.4"/><path d="M17 14.6v2.6l1.6 1.1"/>',
};

export function toolIcon(id: ToolId): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${P[id]}</svg>`;
}
