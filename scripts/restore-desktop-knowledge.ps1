param(
 [Parameter(Mandatory=$true)][string]$PreparedRoot,
 [Parameter(Mandatory=$true)][string]$BackupRoot,
 [Parameter(Mandatory=$true)][string]$PlanPath,
 [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference='Stop'
function Sha256([string]$Path){$stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}}
function ReplaceFrom([string]$Source,[string]$Target){
 $parent=Split-Path $Target -Parent
 $temporary=Join-Path $parent ('.restore-'+[Guid]::NewGuid().ToString('N')+'.tmp')
 $replacementBackup=Join-Path $parent ('.restore-'+[Guid]::NewGuid().ToString('N')+'.previous')
 try{[IO.File]::Copy($Source,$temporary,$false);if([IO.File]::Exists($Target)){[IO.File]::Replace($temporary,$Target,$replacementBackup)}else{[IO.File]::Move($temporary,$Target)}}finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)};if([IO.File]::Exists($replacementBackup)){try{[IO.File]::Delete($replacementBackup)}catch{}}}
}
$changed=@()
try {
 if(Get-Process -Name 'interview-cue' -ErrorAction SilentlyContinue){throw '请关闭程序后再恢复题库'}
 $workspace=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
 foreach($inputPath in @($PreparedRoot,$BackupRoot,$PlanPath,$ResultPath)) {if(![IO.Path]::GetFullPath($inputPath).StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)){throw '恢复文件必须位于当前工作区'} }
 $plan=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($plan.format -ne 'mockinterview-desktop-knowledge-repair-v1'){throw '恢复计划格式无效'}
 $profile=Join-Path $env:APPDATA 'app.interviewcue.local'
 $root=Join-Path $profile 'knowledge-library'
 $config=Join-Path $profile 'config.json'
 if((Sha256 $config) -ne $plan.configHash){throw '个人设置已变更或启动环境不一致，原设置已保留，请重新核对'}
 $names=@('library.json','inbox.json','index.sqlite')
 foreach($name in $names){
  $entry=@($plan.files|Where-Object {$_.name -eq $name})
  if($entry.Count -ne 1){throw '恢复计划缺少文件校验'}
  if((Sha256 (Join-Path $root $name)) -ne $entry[0].before){throw '题库已变更，未覆盖新数据'}
  if((Sha256 (Join-Path $PreparedRoot $name)) -ne $entry[0].after){throw '暂存文件校验失败'}
  if((Sha256 (Join-Path $BackupRoot $name)) -ne $entry[0].before){throw '备份文件校验失败'}
 }
 $library=Get-Content -LiteralPath (Join-Path $PreparedRoot 'library.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $inbox=Get-Content -LiteralPath (Join-Path $PreparedRoot 'inbox.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($library.sources.Count -ne $plan.sources -or $inbox.items.Count -ne $plan.items){throw '恢复数量与计划不一致'}
 foreach($name in $names){ReplaceFrom (Join-Path $PreparedRoot $name) (Join-Path $root $name);$changed+=$name}
 foreach($name in $names){$entry=@($plan.files|Where-Object {$_.name -eq $name});if((Sha256 (Join-Path $root $name)) -ne $entry[0].after){throw '恢复后校验失败'}}
 if((Sha256 $config) -ne $plan.configHash){throw '个人设置发生变化，请核对'}
 $diagnostics=Join-Path $root '.diagnostics'
 [IO.Directory]::CreateDirectory($diagnostics)|Out-Null
 [IO.File]::WriteAllText((Join-Path $diagnostics 'enabled'),'1')
 $settings=(Get-Content -LiteralPath $config -Raw -Encoding UTF8|ConvertFrom-Json).interview_profile.settings
 [ordered]@{ok=$true;root=$root;sources=$library.sources.Count;items=$inbox.items.Count;buildModel=$library.buildModel;bankEnabled=$library.enabled;configUnchanged=$true;configHash=$plan.configHash;theme=$settings.theme;opacity=$settings.opacity;replacedFiles=$changed;backup=$BackupRoot;networkCalls=0}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $ResultPath -Encoding UTF8
}catch{
 $errorMessage=$_.Exception.Message
 $rollbackErrors=@()
 foreach($name in $changed){try{ReplaceFrom (Join-Path $BackupRoot $name) (Join-Path $root $name)}catch{$rollbackErrors+=$_.Exception.Message}}
 [ordered]@{ok=$false;error=$errorMessage;rolledBackFiles=$changed;rollbackErrors=$rollbackErrors}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $ResultPath -Encoding UTF8
 exit 1
}
