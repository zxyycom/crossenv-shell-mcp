$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$expectedShell = [Console]::In.ReadLine()
if ($expectedShell -ne '-' -and $expectedShell -ne ($PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor.ToString() + ':' + $PSVersionTable.PSEdition)) {
  [Console]::Error.WriteLine('Shell version mismatch')
  exit 125
}
Remove-Variable expectedShell
& ([scriptblock]::Create([Console]::In.ReadToEnd()))
