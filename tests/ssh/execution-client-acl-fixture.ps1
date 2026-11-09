param([Parameter(Mandatory)][string]$File, [Parameter(Mandatory)][string]$Reference, [switch]$Restore)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Restore) { Set-Acl -LiteralPath $File -AclObject (Get-Acl -LiteralPath $Reference); exit }
$acl = Get-Acl -LiteralPath $File
$rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Write', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $File -AclObject $acl
