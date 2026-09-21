import { NextRequest, NextResponse } from "next/server";

export interface DockerHubTagItem {
  name: string;
  last_updated?: string;
  full_size?: number;
  is_latest?: boolean;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  let image = searchParams.get("image")?.trim() || "";

  if (!image) {
    return NextResponse.json({ results: [] });
  }

  // If the user supplied image with a tag (e.g. "mysql:8.4" or "nginx:alpine"), strip the tag to get repository name
  if (image.includes(":")) {
    image = image.split(":")[0];
  }

  // Docker Hub official images reside in the "library/" namespace
  const repo = image.includes("/") ? image : `library/${image}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const dockerHubUrl = `https://hub.docker.com/v2/repositories/${encodeURIComponent(
      repo.split("/")[0]
    )}/${encodeURIComponent(repo.split("/")[1] || "")}/tags?page_size=60&ordering=last_updated`;

    const res = await fetch(dockerHubUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      // Return graceful fallback with standard tags
      return NextResponse.json({
        results: [
          { name: "latest", is_latest: true },
          { name: "alpine" },
          { name: "slim" },
        ],
        warning: `Docker Hub returned status ${res.status}`,
      });
    }

    const data = await res.json();
    const rawResults = Array.isArray(data?.results) ? data.results : [];

    const tags: DockerHubTagItem[] = rawResults
      .map((item: any) => ({
        name: item.name || "",
        last_updated: item.last_updated || item.tag_last_pushed || "",
        full_size: item.full_size ?? item.images?.[0]?.size ?? 0,
        is_latest: item.name === "latest",
      }))
      .filter((t: DockerHubTagItem) => {
        if (!t.name) return false;
        if (t.name.startsWith("sha256-")) return false;
        if (t.name.endsWith(".sig") || t.name.endsWith(".att") || t.name.endsWith(".metadata") || t.name.endsWith("-metadata")) return false;
        return true;
      });

    // Ensure "latest" is prioritized first if found, or add it if results exist but latest wasn't in recent page
    const latestIndex = tags.findIndex((t) => t.name === "latest");
    if (latestIndex > 0) {
      const [latestTag] = tags.splice(latestIndex, 1);
      tags.unshift(latestTag);
    } else if (latestIndex === -1 && tags.length > 0) {
      tags.unshift({ name: "latest", is_latest: true });
    }

    return NextResponse.json({ results: tags });
  } catch (error: any) {
    return NextResponse.json({
      results: [
        { name: "latest", is_latest: true },
        { name: "alpine" },
      ],
      warning: error?.message || "Failed to query Docker Hub tags",
    });
  }
}
