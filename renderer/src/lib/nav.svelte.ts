/** Cross-component signal: which Setup section to open for editing. Lets the pipeline
 * summary (on the dashboard or the setup screen) jump straight into a section's edit. */
export const editNav = $state<{ section: string }>({ section: '' });

/** Request editing a Setup section (ai / repo / tracker / workspace / channel) and
 * navigate to the Setup screen if we're not already there. */
export function editSection(section: string): void {
  editNav.section = section;
  if (typeof location !== 'undefined' && !location.hash.startsWith('#/settings')) {
    location.hash = '#/settings';
  }
}
