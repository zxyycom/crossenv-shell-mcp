param(
    [Parameter(Mandatory)][ValidateSet('Deny', 'Restore')][string]$Action,
    [Parameter(Mandatory)][string]$FixtureRoot,
    [string]$SddlBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\')
$temporary = [IO.Path]::GetTempPath().TrimEnd('\')
if ([IO.Path]::GetDirectoryName($root) -ine $temporary -or [IO.Path]::GetFileName($root) -notlike 'project-file-fault-*') {
    throw 'ACL fixture scope mismatch'
}
$directory = Join-Path $root 'denied'
if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ACL fixture must be a real directory' }

if ($Action -eq 'Deny') {
    $acl = Get-Acl -LiteralPath $directory
    $backup = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acl.Sddl))
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,
        [Security.AccessControl.FileSystemRights]::CreateFiles,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Deny)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $directory -AclObject $acl
    [Console]::WriteLine($backup)
}
else {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $sddl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SddlBase64))
    $acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $directory -AclObject $acl
    [Console]::WriteLine('RESTORED')
}
