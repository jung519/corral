/**
 * The editable sections of the Setup screen.
 *
 * A union rather than `string` so a rename breaks the build. The summary's buttons pass
 * these by name, and a name that matches nothing opens nothing — silently, which is the
 * kind of dead button nobody notices until they press it (CRL-121).
 */
export type Section = 'ai' | 'repo' | 'tracker' | 'workspace' | 'channel';

/** Cross-component signal: which Setup section to open for editing. Lets the pipeline
 * summary (on the dashboard or the setup screen) jump straight into a section's edit. */
export const editNav = $state<{ section: Section | '' }>({ section: '' });

/** Request editing a Setup section and navigate to the Setup screen if we're not already
 * there. Setup then brings that section into view and puts focus on it. */
export function editSection(section: Section): void {
  editNav.section = section;
  if (typeof location !== 'undefined' && !location.hash.startsWith('#/settings')) {
    location.hash = '#/settings';
  }
}
