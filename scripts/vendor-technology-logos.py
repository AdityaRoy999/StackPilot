"""Vendor the small set of brand SVGs used by manifest inspection (no runtime CDN)."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen
import json
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
slugs = {
    'react':'react', 'nextjs':'nextdotjs', 'vue':'vuedotjs', 'nuxt':'nuxt', 'svelte':'svelte',
    'angular':'angular', 'astro':'astro', 'express':'express', 'fastify':'fastify', 'nestjs':'nestjs',
    'hono':'hono', 'koa':'koa', 'postgres':'postgresql', 'mysql':'mysql', 'mariadb':'mariadb',
    'mongo':'mongodb', 'redis':'redis', 'valkey':'valkey', 'rabbitmq':'rabbitmq', 'sqlite':'sqlite',
    'prisma':'prisma', 'supabase':'supabase', 'node':'nodedotjs', 'python':'python', 'go':'go',
    'rust':'rust', 'nginx':'nginx', 'caddy':'caddy', 'minio':'minio', 'neo4j':'neo4j',
    'clickhouse-server':'clickhouse', 'prometheus':'prometheus', 'grafana':'grafana', 'loki':'grafana',
    'django':'django', 'flask':'flask', 'fastapi':'fastapi', 'starlette':'starlette', 'gin':'gin',
    'actix':'actix', 'spring':'springboot', 'php':'php', 'laravel':'laravel', 'ruby':'ruby',
    'rails':'rubyonrails', 'cpp':'cplusplus', 'dotnet':'dotnet', 'aspnet':'dotnet',
    'docker':'docker', 'kubernetes':'kubernetes', 'cloudflare':'cloudflare',
}
version = '16.0.0'
base = f'https://raw.githubusercontent.com/simple-icons/simple-icons/{version}'

def fetch(slug):
    try:
        data = urlopen(f'{base}/icons/{slug}.svg', timeout=15).read(100_000).decode()
        svg = ET.fromstring(data)
        # Simple Icons are static single-path silhouettes. Reject any other
        # document structure instead of introducing external/active SVG content.
        paths = [node.attrib['d'] for node in svg if node.tag.endswith('path')]
        if len(paths) != 1 or svg.attrib.get('viewBox') != '0 0 24 24':
            raise ValueError('unexpected SVG structure')
        return slug, paths[0]
    except Exception as error:
        return slug, None

with ThreadPoolExecutor(max_workers=8) as pool:
    fetched = dict(pool.map(fetch, sorted(set(slugs.values()))))
logos = {id: fetched[slug] for id,slug in slugs.items() if fetched[slug]}
target = root/'frontend/src/lib/technology-logos.ts'
target.write_text('// Vendored Simple Icons '+version+' (CC0). See technology-logos.LICENSE.md.\n'
    '// Static SVG path data; no remote resources or runtime icon package.\n'
    +'export const technologyLogoPaths: Record<string, string> = '+json.dumps(logos, indent=2)+';\n', encoding='utf-8')
license_text = urlopen(base+'/LICENSE.md', timeout=15).read().decode()
(target.parent/'technology-logos.LICENSE.md').write_text('Source: https://github.com/simple-icons/simple-icons/tree/'+version+'\n\n'+license_text, encoding='utf-8')
print(json.dumps({'logos':len(logos), 'unavailable':[id for id in slugs if id not in logos]}))
