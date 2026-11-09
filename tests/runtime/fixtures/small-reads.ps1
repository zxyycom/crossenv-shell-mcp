param([Parameter(Mandatory)][string]$TargetProgram)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'small-reads.cs')
$stream = [SmallReadFixture]::new([Console]::OpenStandardInput())
& $TargetProgram -InputStream $stream
