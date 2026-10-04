import api from "@/lib/api";

export function onboardingDestination(preferences?: { preferences?: Record<string, unknown> }) {
  return preferences?.preferences?.setup_completed === true ? "/dashboard" : "/dashboard/setup";
}

export async function destinationAfterLogin() {
  try {
    const response = await api.get("/auth/me", { timeout: 5000 });
    return onboardingDestination(response.data.user?.preferences);
  } catch {
    // A transient preferences failure must not make a successful login unusable.
    return "/dashboard";
  }
}
