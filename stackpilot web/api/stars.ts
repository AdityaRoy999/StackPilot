// Vercel Serverless Function to fetch and cache GitHub stars for StackPilot
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 1. Try ungh.cc first (no rate limits, fast edge cache)
    try {
      const unghRes = await fetch('https://ungh.cc/repos/AdityaRoy999/StackPilot');
      if (unghRes.ok) {
        const data = await unghRes.json();
        if (typeof data?.repo?.stars === 'number') {
          return res.status(200).json({ stars: data.repo.stars });
        }
      }
    } catch {
      // fallback
    }

    // 2. Try GitHub official API
    try {
      const ghRes = await fetch('https://api.github.com/repos/AdityaRoy999/StackPilot', {
        headers: {
          'User-Agent': 'StackPilot-Web',
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (ghRes.ok) {
        const data = await ghRes.json();
        if (typeof data.stargazers_count === 'number') {
          return res.status(200).json({ stars: data.stargazers_count });
        }
      }
    } catch {
      // fallback
    }

    // 3. Fallback baseline if all remote endpoints are unreachable
    return res.status(200).json({ stars: 4 });
  } catch {
    return res.status(200).json({ stars: 4 });
  }
}
