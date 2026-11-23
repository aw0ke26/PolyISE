// Finds the current version of a download and the vendor's own published SHA-256 for it,
// so the catalog doesn't need hand-copied versions and hashes.
//
// source.kind:
//   github  -> latest GitHub release; hash from the asset's "digest" field
//   go      -> go.dev/dl JSON; hash published by the Go team
//   node    -> nodejs.org index + SHASUMS256.txt
//   python  -> python.org; hash from python.org's release API when it provides one
//   (none)  -> entry.url / entry.version / entry.sha256 are used as written (pinned)

const UA = { 'User-Agent': 'POLY-ISE', Accept: 'application/json' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'POLY-ISE' } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function github(src) {
  const rel = await getJson(`https://api.github.com/repos/${src.repo}/releases/latest`);
  const re = new RegExp(src.asset);
  const asset = (rel.assets || []).find((a) => re.test(a.name));
  if (!asset) {
    const names = (rel.assets || []).map((a) => a.name).filter((n) => /win/i.test(n)).slice(0, 8).join(', ');
    throw new Error(`${src.repo} ${rel.tag_name} has no file matching ${src.asset}. Windows files in that release: ${names || 'none'}. The catalog entry needs updating.`);
  }
  const sha = asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
  return { version: rel.tag_name, url: asset.browser_download_url, sha256: sha, hashSource: sha ? 'GitHub release digest' : '' };
}

async function go(src) {
  const list = await getJson('https://go.dev/dl/?mode=json');
  const rel = list.find((r) => r.stable);
  const file = rel.files.find((f) => f.os === 'windows' && f.arch === (src.arch || 'amd64') && f.kind === 'archive' && f.filename.endsWith('.zip'));
  if (!file) throw new Error('No Windows Go zip found');
  return { version: rel.version, url: `https://go.dev/dl/${file.filename}`, sha256: file.sha256, hashSource: 'go.dev' };
}

async function node(src) {
  const index = await getJson('https://nodejs.org/dist/index.json');
  const rel = index.find((r) => r.lts && r.version.startsWith(`v${src.major}.`) && (r.files || []).includes('win-x64-zip'));
  if (!rel) throw new Error(`No Node ${src.major} LTS found`);
  const name = `node-${rel.version}-win-x64.zip`;
  const sums = await getText(`https://nodejs.org/dist/${rel.version}/SHASUMS256.txt`);
  const line = sums.split('\n').find((l) => l.trim().endsWith(' ' + name));
  return { version: rel.version, url: `https://nodejs.org/dist/${rel.version}/${name}`, sha256: line ? line.split(/\s+/)[0] : '', hashSource: line ? 'nodejs.org SHASUMS256' : '' };
}

async function python(src) {
  const listing = await getText('https://www.python.org/ftp/python/');
  const esc = src.series.replace('.', '\\.');
  const versions = [...listing.matchAll(new RegExp(`href="(${esc}\\.\\d+)/"`, 'g'))].map((m) => m[1])
    .sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]));
  for (const v of versions) {
    const url = `https://www.python.org/ftp/python/${v}/python-${v}-embed-amd64.zip`;
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) continue;
    let sha = '';
    try {
      const rels = await getJson(`https://www.python.org/api/v2/downloads/release/?name=${encodeURIComponent('Python ' + v)}`);
      if (rels[0]) {
        const id = rels[0].resource_uri.match(/(\d+)\/?$/)[1];
        const files = await getJson(`https://www.python.org/api/v2/downloads/release_file/?release=${id}`);
        const f = files.find((x) => x.url === url);
        if (f && f.sha256_sum) sha = f.sha256_sum;
      }
    } catch { /* hash lookup is best effort */ }
    return { version: v, url, sha256: sha, hashSource: sha ? 'python.org' : '' };
  }
  throw new Error(`No Python ${src.series} embeddable build found`);
}

async function resolve(entry) {
  const src = entry.source;
  if (!src) return { version: entry.version || '', url: entry.url, sha256: entry.sha256 || '', hashSource: entry.sha256 ? 'catalog' : '' };
  if (src.pin) return { version: src.pin.version, url: src.pin.url, sha256: src.pin.sha256 || '', hashSource: 'catalog' };
  if (src.kind === 'github') return github(src);
  if (src.kind === 'go') return go(src);
  if (src.kind === 'node') return node(src);
  if (src.kind === 'python') return python(src);
  throw new Error(`Unknown source kind ${src.kind}`);
}

module.exports = { resolve };
