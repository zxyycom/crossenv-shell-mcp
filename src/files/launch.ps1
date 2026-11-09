Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $stream = [Console]::OpenStandardInput()
    }
    else {
        Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PROJECT_FILE_STDIO_BASE64__')))
        $stream = [ProjectFileStdio]::OpenInput()
    }
}
catch {
    [Console]::Error.WriteLine('PFT1 {"event":"error","code":"target_unavailable","published":false,"cleanupFailed":false}')
    exit 1
}
$bytes = [Collections.Generic.List[byte]]::new()
while ($true) {
    $next = $stream.ReadByte()
    if ($next -eq 10) { break }
    if ($next -lt 0 -or $next -gt 127 -or $bytes.Count -ge 65536) { exit 1 }
    [void]$bytes.Add([byte]$next)
}
$source = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($bytes.ToArray())))
try { & ([ScriptBlock]::Create($source)) -InputStream $stream }
finally { $stream.Dispose() }
