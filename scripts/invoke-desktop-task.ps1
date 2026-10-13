param(
 [Parameter(Mandatory=$true)][string]$Script,
 [Parameter(Mandatory=$true)][hashtable]$Arguments,
 [Parameter(Mandatory=$true)][string]$ResultPath,
 [ValidateRange(1,60)][int]$TimeoutSeconds=20
)
$ErrorActionPreference='Stop'
# MSIX AppData redirection can persist even with unrestricted filesystem access.
# Ask the actual Explorer desktop process to launch this local maintenance task.
$workspace=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
foreach($path in @($Script,$ResultPath)){
 if(![IO.Path]::IsPathRooted($path) -or ![IO.Path]::GetFullPath($path).StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)){
  throw 'The task script and result must be absolute paths inside this workspace'
 }
}
if([IO.Path]::GetExtension($Script) -ne '.ps1' -or !(Test-Path -LiteralPath $Script)){throw 'Select an existing PowerShell maintenance script'}
if(Test-Path -LiteralPath $ResultPath){throw 'Use a fresh result file to avoid reading stale task output'}
if($Arguments.ContainsKey('ResultPath')){throw 'ResultPath is supplied by the launcher'}
function Quote([string]$Value){if($Value -match '["\r\n]'){throw 'Invalid task argument'};return '"'+$Value+'"'}
$parts=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Quote $Script))
foreach($entry in $Arguments.GetEnumerator()){
 if([string]$entry.Key -notmatch '^[A-Za-z][A-Za-z0-9]*$'){throw 'Invalid parameter name'}
 $parts+=@('-'+$entry.Key,(Quote ([string]$entry.Value)))
}
$parts+=@('-ResultPath',(Quote $ResultPath))
$location=0;$root=0;$desktopHwnd=0
$shell=New-Object -ComObject Shell.Application
$desktop=$shell.Windows().FindWindowSW([ref]$location,[ref]$root,8,[ref]$desktopHwnd,1)
if($null -eq $desktop.Document.Application){throw 'The Windows desktop shell is unavailable; no task was launched'}
$desktop.Document.Application.ShellExecute((Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'),($parts -join ' '),$workspace,'open',0)
$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while(!(Test-Path -LiteralPath $ResultPath)){
 if([DateTime]::UtcNow -ge $deadline){throw 'The desktop task has not returned; inspect its status before retrying'}
 Start-Sleep -Milliseconds 150
}
$result=Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8|ConvertFrom-Json
if(!$result.ok){throw $result.error}
$result
