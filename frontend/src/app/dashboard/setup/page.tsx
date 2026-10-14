import { redirect } from "next/navigation";

/** Old bookmarks open projects without a separate onboarding page. */
export default function SetupPage() { return redirect("/dashboard"); }
