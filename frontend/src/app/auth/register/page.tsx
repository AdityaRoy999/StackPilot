import { RegisterClient } from "@/components/auth/RegisterClient";

export const dynamic = "force-dynamic";

export default function RegisterPage() {
  const googleClientId =
    process.env["NEXT_PUBLIC_GOOGLE_CLIENT_ID"] || process.env["GOOGLE_CLIENT_ID"] || "";
  const githubOAuthEnabled = Boolean(
    process.env["NEXT_PUBLIC_GITHUB_CLIENT_ID"] ||
      process.env["GITHUB_CLIENT_ID"] ||
      process.env["GITHUB_APP_CLIENT_ID"],
  );

  return <RegisterClient googleClientId={googleClientId} githubOAuthEnabled={githubOAuthEnabled} />;
}
