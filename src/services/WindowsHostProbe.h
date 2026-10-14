#pragma once
#include <openssl/evp.h>
#include <string>
#include <stdexcept>

namespace stackpilot {
// Fixed, read-only PowerShell. No repository scripts or private environment
// values are accepted by this capability probe.
inline std::string windowsHostProbeScript() {
    return R"ps($ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if ($env:OS -ne 'Windows_NT') { exit 2 }
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Emit($key,$value) { Write-Output ($key+'='+([string]$value -replace '[\r\n]',' ')) }
function Available($name) { if (Get-Command $name -CommandType Application -ErrorAction SilentlyContinue) { 'yes' } else { 'no' } }
Write-Output '__STACKPILOT_PROBE_START__'
Emit 'os_family' 'windows'
Emit 'os' ([Environment]::OSVersion.VersionString)
Emit 'arch' $env:PROCESSOR_ARCHITECTURE
Emit 'user' ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
Emit 'powershell' $PSVersionTable.PSVersion
Emit 'dotnet_cli' (Available 'dotnet.exe')
if (Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue) {
    $sdks=@(& dotnet.exe --list-sdks 2>$null)
    if ($sdks.Count) { Emit 'dotnet_sdks' (($sdks | ForEach-Object { ($_ -split ' ')[0] }) -join ', ') } else { Emit 'dotnet_sdks' 'none installed' }
}
Emit 'node_cli' (Available 'node.exe')
Emit 'java_cli' (Available 'java.exe')
Emit 'git_cli' (Available 'git.exe')
Emit 'python_cli' (Available 'python.exe')
Emit 'msbuild_cli' (Available 'MSBuild.exe')
Emit 'signing_cli' (Available 'signtool.exe')
Emit 'native_gui_verification' 'requires_interactive_worker'
Emit 'windows_worker' 'not_enrolled'
try {
    $os=Get-CimInstance Win32_OperatingSystem
    Emit 'memory' ($os.FreePhysicalMemory.ToString()+'KB_available')
    $disk=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$env:SystemDrive+"'")
    Emit 'disk' ([Math]::Floor($disk.FreeSpace/1024).ToString()+'KB_free')
} catch { Emit 'capacity_probe' 'unavailable' }
Write-Output '__STACKPILOT_PROBE_END__'
)ps";
}

inline std::string windowsHostProbeCommand() {
    std::string utf16;
    for (unsigned char character:windowsHostProbeScript()) { utf16.push_back(character);utf16.push_back('\0'); }
    std::string encoded(4*((utf16.size()+2)/3)+1,'\0');
    const int size=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),reinterpret_cast<const unsigned char*>(utf16.data()),static_cast<int>(utf16.size()));
    if(size<0)throw std::runtime_error("Failed to encode Windows capability probe");
    encoded.resize(size);
    return "powershell.exe -NoProfile -NonInteractive -EncodedCommand "+encoded;
}
}
