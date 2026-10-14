# Connect an isolated Windows VM

Open **Settings → Remote Connections → Connect a Windows VM** for the short
setup guide. Use **Standard SSH**. A Windows OpenSSH host is detected automatically
when you select **Probe Host**; no Linux default shell is required.

For desktop access inside StackPilot, open **Settings → Remote Connections → Remote desktops**. Add an
RDP connection or import a `.rdp` file, review its details, enter the Windows
password privately in the form, and choose **Open**. See the
[RDP setup guide](rdp-connections.md). Keep the SSH connection for host probing
and worker operations; RDP provides the interactive desktop.

## Prepare the VM

Run in an administrator PowerShell window **on the isolated VM**:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

If OpenSSH Server is already installed, start the service directly. Installation
normally creates the `OpenSSH-Server-In-TCP` firewall rule. Verify that port 22
is reachable from the StackPilot backend and enable that rule if needed. Use
the VM's address that the backend can reach, rather than the laptop's loopback
address. Microsoft's [OpenSSH installation guide](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
documents the service and firewall configuration.

Create/use a Windows account for this isolated worker. Password authentication
uses that account's password. Key authentication requires the matching public
key in the VM's authorized-key file. Administrator accounts use
`C:\ProgramData\ssh\administrators_authorized_keys`; other accounts use
their `.ssh\authorized_keys` file. See [Microsoft's Windows OpenSSH configuration](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration).
Enter credentials only in StackPilot's connection form.

## Save the connection

| Field | Value |
| --- | --- |
| Connection type | Standard SSH |
| Connection name | A name such as `windows-build-vm` |
| Host | Reachable VM IP or hostname |
| Port | `22`, unless changed on the VM |
| Username | The Windows account configured for SSH |
| Authentication | Password or private key |

Select **Save Connection**, **Test Connection**, then **Probe Host**. The probe
uses a fixed, encoded PowerShell command. It reads OS, architecture, PowerShell,
installed .NET SDK versions, and the availability of Node, Java, Git, MSBuild
and signing tools. It does not execute repository code or expose private
environment values. A .NET runtime without an SDK reports `none installed`.
Capability results persist across Settings reloads.

Windows probes hide Linux provisioning and shell actions. SDK discovery is
evidence of installed tools; it does not qualify a repository build.

## Current native Windows limits

Connection storage, authentication testing and SDK discovery are implemented.
Native Windows worker enrollment, build job scheduling, artifact return,
installer execution and interactive GUI acceptance are still unfinished.
An SSH connection alone does not enroll a Windows build worker.

The qualified WPF sample currently builds a self-contained Windows EXE and ZIP
on the Linux .NET SDK using Windows targeting. Its download, digest and PE
architecture are checked. Native execution, installation and Windows release
signing remain unverified. An interactive worker session is required for GUI
testing; ordinary Windows SSH runs do not establish desktop interaction.

After saving the connection, its name or ID and VM address are sufficient for
continuing the worker integration. Do not send the credential value in chat.
