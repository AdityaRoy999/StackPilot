import { useState } from 'react';
import { installCommand, type InstallPlatform, type InstallProfile } from '../config/installation';

export default function InstallSetup() {
  const [platform, setPlatform] = useState<InstallPlatform>('bash');
  const [profile, setProfile] = useState<InstallProfile>('core');
  const [production, setProduction] = useState(false);
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const host = window.location.origin;
  const valid = !production || (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+$/.test(domain) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const command = installCommand(platform, profile, host, production ? domain : '', production ? email : '');
  const controlClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400';
  return <section aria-labelledby="setup-heading" className="mx-auto my-10 max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-8">
    <h2 id="setup-heading" className="text-2xl font-semibold">Install your StackPilot</h2>
    <p className="mt-2 text-sm text-zinc-400">Choose your setup. The installer creates private secrets on your computer; configure AI in dashboard Settings.</p>
    <div className="mt-6 grid gap-4 sm:grid-cols-3">
      <label className="text-sm">Operating system<select className={`${controlClass} mt-2`} value={platform} onChange={event => setPlatform(event.target.value as InstallPlatform)}>
        <option value="bash">Linux / macOS</option><option value="powershell">Windows PowerShell</option>
      </select></label>
      <label className="text-sm">Services<select className={`${controlClass} mt-2`} value={profile} onChange={event => setProfile(event.target.value as InstallProfile)}>
        <option value="base">Deployment platform</option><option value="core">Platform + AI browser</option>
        <option value="full">Full platform + search</option><option value="monitoring">Full platform + monitoring</option>
      </select></label>
      <label className="text-sm">Access<select className={`${controlClass} mt-2`} value={production ? 'production' : 'local'} onChange={event => setProduction(event.target.value === 'production')}>
        <option value="local">Local computer</option><option value="production">Server with HTTPS</option>
      </select></label>
    </div>
    {production && <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Hostname<input className={`${controlClass} mt-2`} value={domain} placeholder="stackpilot.example.com" onChange={event => setDomain(event.target.value)} /></label>
      <label className="text-sm">HTTPS contact email<input type="email" className={`${controlClass} mt-2`} value={email} onChange={event => setEmail(event.target.value)} /></label>
    </div>}
    <p className="mt-4 text-sm text-zinc-400">Requires Git, Docker Compose v2, and Python 3.10+. First installation builds images and can take several minutes.</p>
    <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-zinc-800 bg-black p-4 text-xs leading-6 text-zinc-300"><code>{command}</code></pre>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" disabled={!valid} onClick={async () => { try { await navigator.clipboard.writeText(command); setNotice('Copied installer command.'); } catch { setNotice('Select and copy the command above.'); } }} className="min-h-11 rounded-xl bg-zinc-100 px-4 text-sm font-medium text-black disabled:opacity-40">Copy command</button>
      <a className="min-h-11 rounded-xl border border-zinc-700 px-4 py-3 text-sm" href={platform === 'bash' ? '/install.sh' : '/install.ps1'} download>Download installer</a>
      <a className="text-sm text-zinc-400 underline" href="https://github.com/AdityaRoy999/StackPilot/archive/refs/heads/main.zip">Download source ZIP</a>
      <span role="status" className="text-sm text-zinc-400">{notice}</span>
    </div>
    <p className="mt-3 text-xs text-zinc-500">The copied command includes your choices. A downloaded installer starts with the default profile unless you pass its options.</p>
    {production && !valid && <p role="status" className="mt-3 text-sm text-zinc-400">Enter a hostname and email to generate the HTTPS command.</p>}
    <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm text-zinc-400">
      <li>Run the installer on your computer or server. Existing credentials are preserved.</li>
      <li>Open {production && domain ? `https://${domain}` : 'http://localhost:3000'} and create your account.</li>
      <li>In Settings, connect an AI provider and select a model. API keys stay in your own installation.</li>
    </ol>
  </section>;
}
