/** Text made safe to put inside HTML (the HUD shows URL-supplied engine specs and error messages). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
