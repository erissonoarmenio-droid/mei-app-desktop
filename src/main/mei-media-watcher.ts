/**
 * Mei: observa a musica que esta tocando no Windows (YouTube, Spotify, qualquer player)
 * e avisa a tela quando uma musica comeca, para ela dancar um pouco.
 * Usa um unico PowerShell em segundo plano que le o "controle de midia" do Windows a cada 3 s.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { BrowserWindow } from 'electron';

const SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$last = ''
while ($true) {
  $out = 'None|'
  $s = $mgr.GetCurrentSession()
  if ($s) {
    $st = $s.GetPlaybackInfo().PlaybackStatus
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $out = "$st|$($p.Title)"
  }
  if ($out -ne $last) { Write-Output $out; $last = $out }
  Start-Sleep -Seconds 3
}
`;

let proc: ChildProcessWithoutNullStreams | null = null;

export function startMeiMediaWatcher(getWindow: () => BrowserWindow | null | undefined): void {
  if (process.platform !== 'win32' || proc) return;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', SCRIPT], { windowsHide: true });
  } catch (e) {
    console.warn('[Mei] media watcher nao iniciou', e);
    return;
  }
  let anterior = { status: 'None', titulo: '' };
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const linhas = buffer.split(/\r?\n/);
    buffer = linhas.pop() ?? '';
    linhas.forEach((linha) => {
      const [status, ...resto] = linha.trim().split('|');
      const titulo = resto.join('|');
      if (!status) return;
      const comecou = status === 'Playing' && (anterior.status !== 'Playing' || titulo !== anterior.titulo);
      anterior = { status, titulo };
      if (comecou) getWindow()?.webContents.send('mei-musica', titulo);
    });
  });
  proc.on('exit', () => { proc = null; });
}

export function stopMeiMediaWatcher(): void {
  proc?.kill();
  proc = null;
}
