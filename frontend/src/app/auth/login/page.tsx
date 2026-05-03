import { LoginClient } from "@/components/auth/LoginClient";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
  const githubOAuthEnabled = Boolean(process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID);

  return <LoginClient googleClientId={googleClientId} githubOAuthEnabled={githubOAuthEnabled} />;
}
