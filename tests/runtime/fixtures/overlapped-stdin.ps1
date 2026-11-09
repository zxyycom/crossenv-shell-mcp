param([Parameter(Mandatory)][string]$EncodedPayload)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'overlapped-stdin.cs')
[OverlappedInputFixture]::Install()
& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($EncodedPayload))))
