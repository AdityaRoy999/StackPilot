/** Sign-in goes directly to projects; setup is configured from Settings. */
export function onboardingDestination() { return "/dashboard"; }
export async function destinationAfterLogin() { return onboardingDestination(); }
