param([Parameter(Mandatory)][IO.Stream]$InputStream)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$dataStream = $null
$temporary = $null
$ownsTemporary = $false
$temporaryCreated = $null
$published = $false
$failure = $null
$cleanupFailed = $false
$finalBytes = 0L
$reportedBytes = 0L
$progressClock = [Diagnostics.Stopwatch]::StartNew()
$reportedAt = 0L
$finalHash = ''
$parent = $null
$parentCreated = $null

function Emit-FileEvent([hashtable]$Value) {
    [Console]::Error.WriteLine('PFT1 ' + ($Value | ConvertTo-Json -Compress))
}
function Fail-File([string]$Code) { throw [InvalidOperationException]::new('PFT:' + $Code) }
function Read-FileLine([int]$Limit) {
    $bytes = [Collections.Generic.List[byte]]::new()
    while ($true) {
        $next = $inputStream.ReadByte()
        if ($next -eq -1) { Fail-File 'truncated' }
        if ($next -eq 10) { break }
        if ($next -gt 127 -or $bytes.Count -ge $Limit) { Fail-File 'invalid_input' }
        [void]$bytes.Add([byte]$next)
    }
    return [Text.Encoding]::ASCII.GetString($bytes.ToArray())
}
function Check-FileAncestors([string]$Path) {
    $cursor = [IO.Path]::GetDirectoryName($Path)
    while (-not [string]::IsNullOrEmpty($cursor)) {
        if (-not [IO.Directory]::Exists($cursor)) { Fail-File 'parent_missing' }
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-File 'path_link' }
        $next = [IO.Directory]::GetParent($cursor)
        if ($null -eq $next) { break }
        $cursor = $next.FullName
    }
    $attributes = $null
    try { $attributes = [IO.File]::GetAttributes($Path) }
    catch [IO.FileNotFoundException] { }
    if ($null -ne $attributes) {
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-File 'path_link' }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { Fail-File 'not_regular' }
    }
}
function Check-FileParent {
    Check-FileAncestors $target
    if ([IO.Directory]::GetCreationTimeUtc($parent).Ticks -ne $parentCreated) { Fail-File 'source_changed' }
}
function Hash-FileStream([IO.Stream]$Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

try {
    $fields = (Read-FileLine 8192).Split([char]9)
    if ($fields.Length -ne 6 -or $fields[0] -ne 'PFT1' -or $fields[1] -notin @('put', 'get') -or $fields[5] -notmatch '^[a-f0-9-]{36}$') { Fail-File 'invalid_input' }
    $operation = $fields[1]
    $rawPath = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($fields[2]))
    if ($rawPath -notmatch '^[A-Za-z]:[\\/]' -or $rawPath -match '[\x00-\x1f\x7f]' -or [Text.Encoding]::UTF8.GetByteCount($rawPath) -gt 4096) { Fail-File 'invalid_input' }
    if ($rawPath.Substring(2) -match '[<>:"|?*]') { Fail-File 'invalid_input' }
    foreach ($part in $rawPath.Substring(3).Split([char[]]'\/')) {
        if ($part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Fail-File 'invalid_input' }
    }
    $target = [IO.Path]::GetFullPath($rawPath)
    $parent = [IO.Path]::GetDirectoryName($target)
    Check-FileAncestors $target
    $parentCreated = [IO.Directory]::GetCreationTimeUtc($parent).Ticks
    $buffer = New-Object byte[] 65536
    if ($operation -eq 'put') {
        if ($fields[3] -notmatch '^(0|[1-9][0-9]{0,8})$' -or $fields[4] -notmatch '^[a-f0-9]{64}$') { Fail-File 'invalid_input' }
        $size = [long]$fields[3]
        if ($size -gt 104857600) { Fail-File 'too_large' }
        if ([IO.File]::Exists($target)) { Fail-File 'conflict' }
        $temporary = Join-Path $parent ('.project-file-' + $fields[5] + '.part')
        try { $dataStream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { if ([IO.File]::Exists($temporary)) { Fail-File 'conflict' }; throw }
        $ownsTemporary = $true
        $temporaryCreated = [IO.File]::GetCreationTimeUtc($temporary).Ticks
        Emit-FileEvent @{ event = 'ready'; size = $size }
        Emit-FileEvent @{ event = 'phase'; phase = 'transferring' }
        while ($finalBytes -lt $size) {
            $count = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $size - $finalBytes))
            if ($count -eq 0) { Fail-File 'truncated' }
            $dataStream.Write($buffer, 0, $count)
            $finalBytes += $count
            $now = $progressClock.ElapsedMilliseconds
            if ($finalBytes -eq $size -or $finalBytes - $reportedBytes -ge 65536 -or $now - $reportedAt -ge 250) {
                Emit-FileEvent @{ event = 'progress'; bytes = $finalBytes }
                $reportedBytes = $finalBytes
                $reportedAt = $now
            }
        }
        Emit-FileEvent @{ event = 'phase'; phase = 'verifying' }
        $dataStream.Flush($true)
        $finalHash = Hash-FileStream $dataStream
        if ($finalHash -ne $fields[4]) { Fail-File 'hash_mismatch' }
        Emit-FileEvent @{ event = 'verified'; bytes = $finalBytes; sha256 = $finalHash }
        Emit-FileEvent @{ event = 'phase'; phase = 'awaiting_commit' }
        if ((Read-FileLine 16) -ne 'COMMIT') { Fail-File 'protocol_error' }
        Emit-FileEvent @{ event = 'phase'; phase = 'publishing' }
        Check-FileParent
        $dataStream.Dispose()
        $dataStream = $null
        Check-FileAncestors $temporary
        if ([IO.File]::GetCreationTimeUtc($temporary).Ticks -ne $temporaryCreated) { Fail-File 'source_changed' }
        try { [IO.File]::Move($temporary, $target) }
        catch [IO.IOException] { if ([IO.File]::Exists($target)) { Fail-File 'conflict' }; throw }
        $published = $true
        $ownsTemporary = $false
        $temporary = $null
    }
    else {
        if ($fields[3] -ne '-' -or $fields[4] -ne '-') { Fail-File 'invalid_input' }
        if (-not [IO.File]::Exists($target)) { Fail-File 'source_missing' }
        $dataStream = [IO.FileStream]::new($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        Check-FileParent
        $size = $dataStream.Length
        if ($size -gt 104857600) { Fail-File 'too_large' }
        Emit-FileEvent @{ event = 'phase'; phase = 'verifying' }
        $finalHash = Hash-FileStream $dataStream
        $dataStream.Position = 0
        Emit-FileEvent @{ event = 'ready'; size = $size; sha256 = $finalHash }
        Emit-FileEvent @{ event = 'phase'; phase = 'transferring' }
        $output = [Console]::OpenStandardOutput()
        while (($count = $dataStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $output.Write($buffer, 0, $count)
            $finalBytes += $count
        }
        $output.Flush()
        if ($finalBytes -ne $size -or $dataStream.Length -ne $size) { Fail-File 'source_changed' }
        Check-FileParent
    }
}
catch {
    $message = $_.Exception.Message
    $failure = if ($message.StartsWith('PFT:')) { $message.Substring(4) } else { 'io_failed' }
}
finally {
    if ($null -ne $dataStream) {
        try { $dataStream.Dispose() }
        catch { $cleanupFailed = $true }
    }
    if ($ownsTemporary) {
        try {
            Check-FileParent
            Check-FileAncestors $temporary
            if ([IO.File]::Exists($temporary) -and [IO.File]::GetCreationTimeUtc($temporary).Ticks -ne $temporaryCreated) { Fail-File 'source_changed' }
            [IO.File]::Delete($temporary)
        }
        catch { $cleanupFailed = $true }
    }
}
if ($null -ne $failure -or $cleanupFailed) {
    if ($null -eq $failure) { $failure = 'cleanup_failed' }
    Emit-FileEvent @{ event = 'error'; code = $failure; published = $published; cleanupFailed = $cleanupFailed }
    exit 1
}
Emit-FileEvent @{ event = 'complete'; bytes = $finalBytes; sha256 = $finalHash }
