import { describe, it, expect } from 'vitest';
import { installCommand } from './installation';

describe('installation commands', () => {
  it('passes the actual profile to both installer entrypoints', () => {
    expect(installCommand('bash', 'core', 'https://platform.example')).toContain('bash -s -- --profile core');
    expect(installCommand('powershell', 'monitoring', 'https://platform.example')).toContain('-Profile monitoring');
  });
  it('quotes server configuration as literal shell arguments', () => {
    const command = installCommand('bash','full','https://platform.example','stackpilot.example',"admin'$(whoami)@example.com");
    expect(command).toContain("--email 'admin'\\''$(whoami)@example.com'");
    expect(installCommand('powershell','full','https://platform.example','stackpilot.example',"admin'@example.com"))
      .toContain("-Email 'admin''@example.com'");
  });
});
