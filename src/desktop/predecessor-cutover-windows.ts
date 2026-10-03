/** Fixed trusted helper, not user-provided PowerShell. Inspect mode has no
 * terminate rights and never consumes action grants. No PID/tree kill exists.
 * Task COM is not an atomic compare-and-set against a concurrent administrator;
 * pre/post definition checks fail closed but cannot promise zero side effects
 * if another privileged actor replaces the task during the setter call.
 */
export const predecessorCutoverWindowsScript = String.raw`
$ErrorActionPreference='Stop'
$held=New-Object 'Collections.Generic.List[object]'
$heldByPid=@{}
try {
  $bytes=[Convert]::FromBase64String($env:VKODEX_CUTOVER_SCOPE)
  if($bytes.Length -gt 32768) { throw 'scope-limit' }
  $scope=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  $hash=[Security.Cryptography.SHA256]::Create()
  try { $scopeHash=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Collections.Generic;
public sealed class VKodexCutoverHandle : IDisposable {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long b,out long e,out long k,out long u);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder p,ref uint n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
    public uint dwSize,cntUsage,pid; public UIntPtr heap; public uint module,threads,parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="Process32FirstW")] static extern bool First(IntPtr s,ref Entry e);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="Process32NextW")] static extern bool Next(IntPtr s,ref Entry e);
  public sealed class ProcessParent { public uint Pid; public uint Parent; }
  IntPtr handle; FileStream imageFile; readonly bool terminateAllowed;
  static readonly Stopwatch monotonic=Stopwatch.StartNew();
  public static long Now() { return monotonic.ElapsedMilliseconds; }
  public readonly int Pid; public readonly string BirthTicks;
  public VKodexCutoverHandle(int pid,string birth,string image,string digest,bool allowTerminate) {
    Pid=pid; BirthTicks=birth; terminateAllowed=allowTerminate;
    handle=OpenProcess(0x101000u | (allowTerminate ? 1u : 0u),false,pid);
    if(handle==IntPtr.Zero) throw new InvalidOperationException("identity-unproved");
    try {
      if(ExitTicks()!=null) throw new InvalidOperationException("original-not-alive");
      uint count=32768; var actual=new StringBuilder((int)count);
      if(!QueryFullProcessImageName(handle,0,actual,ref count) ||
        !String.Equals(Path.GetFullPath(actual.ToString()),image,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("image-unproved");
      imageFile=new FileStream(image,FileMode.Open,FileAccess.Read,FileShare.Read);
      if(imageFile.Length>268435456) throw new InvalidOperationException("image-limit");
      using(var sha=SHA256.Create()) {
        if(BitConverter.ToString(sha.ComputeHash(imageFile)).Replace("-","").ToLowerInvariant()!=digest) throw new InvalidOperationException("image-unproved");
      }
      if(ExitTicks()!=null) throw new InvalidOperationException("original-not-alive");
    } catch { Dispose(); throw; }
  }
  public string ExitTicks() {
    uint state=WaitForSingleObject(handle,0); long b,e,k,u;
    if((state!=0 && state!=258) || !GetProcessTimes(handle,out b,out e,out k,out u) ||
      DateTime.FromFileTimeUtc(b).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)!=BirthTicks) throw new InvalidOperationException("handle-unproved");
    if(state==258 && e==0) return null;
    if(state!=0 || e<=b) throw new InvalidOperationException("exit-unproved");
    return DateTime.FromFileTimeUtc(e).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  public string Stop(long actionUntil) {
    if(!terminateAllowed) throw new InvalidOperationException("inspect-cannot-stop");
    var exit=ExitTicks(); if(exit!=null) return exit;
    long remaining=actionUntil-Now();
    if(remaining<=0) throw new InvalidOperationException("action-expired");
    if(!TerminateProcess(handle,87) || WaitForSingleObject(handle,(uint)Math.Min(5000,remaining))!=0) throw new InvalidOperationException("stop-unproved");
    exit=ExitTicks(); if(exit==null) throw new InvalidOperationException("stop-unproved"); return exit;
  }
  public static ProcessParent[] Census() {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new InvalidOperationException("census-unavailable");
    try {
      var result=new List<ProcessParent>(); var e=new Entry(); e.dwSize=(uint)Marshal.SizeOf(typeof(Entry));
      if(!First(snapshot,ref e)) throw new InvalidOperationException("census-unavailable");
      do { result.Add(new ProcessParent { Pid=e.pid,Parent=e.parent }); } while(Next(snapshot,ref e));
      if(Marshal.GetLastWin32Error()!=18) throw new InvalidOperationException("census-unavailable");
      return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  // One bounded-generation readback for a process which may have exited after
  // Toolhelp's snapshot. Absence/same original exit is non-live, not PID reuse.
  // Inaccessibility or any different generation remains an unclassified gap.
  public static int ReadCandidate(int pid,string originalBirth) {
    IntPtr candidate=OpenProcess(0x101000,false,pid);
    if(candidate==IntPtr.Zero) return Marshal.GetLastWin32Error()==87 ? 0 : 2;
    try {
      long b,e,k,u;
      if(!GetProcessTimes(candidate,out b,out e,out k,out u) ||
        DateTime.FromFileTimeUtc(b).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)!=originalBirth) return 2;
      uint state=WaitForSingleObject(candidate,0);
      if(state==0 && e>b) return 0;
      return state==258 && e==0 ? 1 : 2;
    } finally { CloseHandle(candidate); }
  }
  public void Dispose() { if(imageFile!=null) { imageFile.Dispose(); imageFile=null; } if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
'@
  function Emit($row) {
    $row.challenge=$scope.challenge; $row.scopeSha256=$scopeHash
    [Console]::Out.WriteLine(($row | ConvertTo-Json -Depth 8 -Compress)); [Console]::Out.Flush()
  }
  function Definition-Hash($task) {
    $xml=New-Object Xml.XmlDocument; $xml.PreserveWhitespace=$false; $xml.XmlResolver=$null
    $settings=New-Object Xml.XmlReaderSettings; $settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit; $settings.XmlResolver=$null
    $stringReader=[IO.StringReader]::new([string]$task.Xml); $reader=[Xml.XmlReader]::Create($stringReader,$settings)
    try { $xml.Load($reader) } finally { $reader.Dispose(); $stringReader.Dispose() }
    $settingsNodes=$xml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Settings"]')
    if($settingsNodes.Count -ne 1) { throw 'definition-settings-unproved' }
    $enabledNodes=$settingsNodes[0].SelectNodes('*[local-name()="Enabled"]')
    if($enabledNodes.Count -gt 1) { throw 'definition-enabled-ambiguous' }
    # Live exported tasks may omit the default true value. Fingerprint every
    # other semantic field, excluding only this separately checked property.
    # Drop formatting whitespace so adding/removing Enabled is equivalent.
    if($enabledNodes.Count -eq 1) {
      if($enabledNodes[0].InnerText -cnotin @('true','false','1','0')) { throw 'definition-enabled-invalid' }
      $null=$settingsNodes[0].RemoveChild($enabledNodes[0])
    }
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml.InnerXml)))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
  }
  $scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
  $separator=$scope.task.path.LastIndexOf('\')
  $folderPath=$scope.task.path.Substring(0,$separator); if($folderPath.Length -eq 0) { $folderPath='\' }
  $taskName=$scope.task.path.Substring($separator+1)
  function Assert-Task([bool]$enabled,[bool]$requireNoInstances) {
    $task=$scheduler.GetFolder($folderPath).GetTask($taskName)
    if([string]$task.Path -cne $scope.task.path -or [bool]$task.Enabled -ne $enabled -or (Definition-Hash $task) -cne $scope.task.definitionSha256) { throw 'task-scope-changed' }
    $actions=$task.Definition.Actions; $wrapper=@($scope.processes | Where-Object { $_.role -ceq 'wrapper' })
    if($actions.Count -ne 1 -or $wrapper.Count -ne 1) { throw 'task-action-unjoined' }
    $action=$actions.Item(1)
    if([int]$action.Type -ne 0 -or -not [string]::Equals([IO.Path]::GetFullPath([string]$action.Path),[string]$wrapper[0].imagePath,[StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetFullPath([string]$action.WorkingDirectory),[string]$scope.legacyRoot,[StringComparison]::OrdinalIgnoreCase) -or
      [string]$action.Arguments -cne ('"'+$scope.legacyRoot+'"')) { throw 'task-action-unjoined' }
    $principal=[string]$task.Definition.Principal.UserId
    if($principal.StartsWith('S-1-')) { $principalSid=$principal }
    else { $principalSid=([Security.Principal.NTAccount]::new($principal)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if($principalSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'task-context-unproved' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $wp=[Security.Principal.WindowsPrincipal]::new($identity)
    if([int]$task.Definition.Principal.RunLevel -eq 1 -and -not $wp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'task-visibility-unproved' }
    $instances=$task.GetInstances(0)
    if($enabled -and ($instances.Count -ne 1 -or [int]$instances.Item(1).EnginePID -ne [int]$wrapper[0].pid)) { throw 'task-wrapper-instance-unjoined' }
    if($requireNoInstances -and $instances.Count -ne 0) { throw 'task-instances-remain' }
    foreach($instance in $instances) {
      $matches=@($scope.task.instances | Where-Object { $_.instanceGuid -ceq [string]$instance.InstanceGuid -and $_.enginePid -eq [int]$instance.EnginePID })
      if($matches.Count -ne 1) { throw 'replacement-task-instance' }
    }
    if($enabled -and $instances.Count -ne @($scope.task.instances).Count) { throw 'initial-task-instances-changed' }
    return $task
  }
  function Assert-Census([bool]$capturePhase) {
    $rows=[VKodexCutoverHandle]::Census()
    # Controller and helper cannot be descendants of any process they may stop.
    # This command must run from an independent trusted parent, not Codex stdio.
    $cursor=[uint32]$scope.controllerPid; $visited=New-Object 'Collections.Generic.HashSet[uint32]'
    while($cursor -ne 0) {
      if(-not $visited.Add($cursor)) { throw 'controller-ancestry-unproved' }
      if(@($scope.processes | Where-Object { $_.pid -eq $cursor }).Count -ne 0) { throw 'controller-within-target-tree' }
      $parent=@($rows | Where-Object { $_.Pid -eq $cursor }); if($parent.Count -ne 1) { throw 'controller-ancestry-unproved' }; $cursor=$parent[0].Parent
    }
    foreach($row in $rows) {
      if(@($scope.processes | Where-Object { $_.pid -eq $row.Parent }).Count -eq 0) { continue }
      $matches=@($scope.processes | Where-Object { $_.pid -eq $row.Pid -and $_.parentPid -eq $row.Parent })
      if($matches.Count -ne 1) { throw 'unclassified-direct-child' }
      $originalHandle=$heldByPid[[string]$row.Pid]
      if($null -eq $originalHandle) { throw 'replacement-process' }
      if($originalHandle.ExitTicks() -ne $null -and [VKodexCutoverHandle]::ReadCandidate([int]$row.Pid,[string]$originalHandle.BirthTicks) -ne 0) { throw 'replacement-process' }
    }
    if($capturePhase) {
      foreach($original in $scope.processes) {
        if(@($rows | Where-Object { $_.Pid -eq $original.pid -and $_.Parent -eq $original.parentPid }).Count -ne 1) { throw 'original-parent-changed' }
      }
    }
  }
  function Grant([int]$sequence,[string]$action) {
    if($scope.mode -cne 'stop' -or [VKodexCutoverHandle]::Now() -ge $actionUntil) { throw 'action-not-current' }
    if([Console]::In.ReadLine() -cne ($scope.challenge+':'+$sequence+':'+$action)) { throw 'grant-invalid' }
    if([VKodexCutoverHandle]::Now() -ge $actionUntil) { throw 'action-not-current' }
  }
  if($scope.mode -cnotin @('inspect','stop')) { throw 'mode-invalid' }
  foreach($p in $scope.processes) {
    $handle=[VKodexCutoverHandle]::new($p.pid,$p.birthTicks,$p.imagePath,$p.imageSha256,($scope.mode -ceq 'stop'))
    $held.Add($handle); $heldByPid[[string]$p.pid]=$handle
  }
  $null=Assert-Task $true $false; Assert-Census $true
  foreach($handle in $held) { if($handle.ExitTicks() -ne $null) { throw 'original-not-alive' } }
  Emit @{kind='ready';processCount=$held.Count}
  if($scope.mode -ceq 'inspect') { exit 0 }
  $actionUntil=[VKodexCutoverHandle]::Now()+$scope.deadlineMs
  Grant 0 'disable-task'; $task=Assert-Task $true $false; Assert-Census $true
  if([VKodexCutoverHandle]::Now() -ge $actionUntil) { throw 'action-expired' }
  $task.Enabled=$false
  $null=Assert-Task $false $false; Emit @{kind='step';sequence=0;action='disable-task'}
  $sequence=1
  foreach($role in @('supervisor','watchdog','wrapper','bridge','backend')) {
    foreach($p in @($scope.processes | Where-Object { $_.role -ceq $role })) {
      $action='stop-'+$p.pid
      Grant $sequence $action; $null=Assert-Task $false $false; Assert-Census $false
      $exit=$heldByPid[[string]$p.pid].Stop([long]$actionUntil)
      Emit @{kind='step';sequence=$sequence;action=$action;pid=[int]$p.pid;birthTicks=[string]$p.birthTicks;exitTicks=$exit}
      $sequence++
    }
  }
  $null=Assert-Task $false $true; Assert-Census $false
  Emit @{kind='stopped';sequence=$sequence}
  # Keep all exact handles and disabled-task scope alive across data-only backup.
  Grant $sequence 'final-check'; $null=Assert-Task $false $true; Assert-Census $false
  foreach($handle in $held) { if($handle.ExitTicks() -eq $null) { throw 'original-still-alive' } }
  Emit @{kind='verified';sequence=$sequence}
} catch {
  if($scope -and $scopeHash) { Emit @{kind='unavailable'} }
  else { [Console]::Out.WriteLine('{"kind":"unavailable"}'); [Console]::Out.Flush() }
  exit 87
} finally { foreach($handle in $held) { $handle.Dispose() } }
`;
