export type InstallPlatform = 'bash' | 'powershell';
export type InstallProfile = 'base' | 'core' | 'full' | 'monitoring';
const bashQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const powershellQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function installCommand(platform: InstallPlatform, profile: InstallProfile, host: string, domain = '', email = '') {
  if (platform === 'powershell') {
    return `& ([scriptblock]::Create((irm ${powershellQuote(`${host}/install.ps1`)}))) -Profile ${profile}` +
      (domain ? ` -Domain ${powershellQuote(domain)} -Email ${powershellQuote(email)}` : '');
  }
  return `curl -fsSL ${bashQuote(`${host}/install.sh`)} | bash -s -- --profile ${profile}` +
    (domain ? ` --domain ${bashQuote(domain)} --email ${bashQuote(email)}` : '');
}
