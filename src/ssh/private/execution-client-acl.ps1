param([Parameter(Mandatory)][ValidateSet('Check','Protect')][string]$Action, [Parameter(Mandatory)][string]$PathsBase64)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathsBase64)))
if (@($paths).Count -eq 0) { throw 'No paths supplied' }
$caller = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($caller.Value, 'S-1-5-18', 'S-1-5-32-544')
$write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not accepted' }
    if ($Action -eq 'Protect') {
        if (!$item.PSIsContainer) { throw 'Only a new directory may be protected' }
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in ($allowed | Select-Object -Unique)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Untrusted owner' }
    foreach ($entry in $acl.Access) {
        if ($entry.AccessControlType -eq 'Allow' -and ($entry.FileSystemRights -band $write) -ne 0) {
            $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($sid -notin $allowed) { throw 'Untrusted write access' }
        }
    }
}
