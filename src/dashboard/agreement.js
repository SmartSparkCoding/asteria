/**
 * The one thing Orbit asks a person to decide, once.
 *
 * The yearly recap is built from huddle history and the moments people submit
 * on a channel's recap page. It never reads or stores message bodies, so the
 * wording says exactly that rather than implying otherwise.
 *
 * The version string is the whole point of the record: bump it and everybody
 * is asked again, which is what a change in what we ask for requires.
 */
export const RECAP_AGREEMENT_VERSION = '2026-10-recaps';

export const RECAP_AGREEMENT = {
  title: 'Yearly recaps',
  body: 'Orbit puts together a yearly recap of huddles. Allow it to use your huddle history and the moments you submit in recaps.',
  note: 'Orbit never reads or stores your messages. This covers huddles you were in and recaps you choose to share, and you can change it whenever you like.',
};
