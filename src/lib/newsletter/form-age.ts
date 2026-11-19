// How old a signup form token must be, shared by the form and the server.
// Too young means something posted faster than a person fills the form in.
export const FORM_TOKEN_MIN_AGE_MS = 2000;
export const FORM_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
