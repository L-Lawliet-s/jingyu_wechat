import path from 'node:path';
import { spawn } from 'node:child_process';
import { fault } from './store.mjs';

export const LIFE_OCR_LIMIT = 1_100_000;
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
$operationName = 'IAsyncOperation' + [char]96 + '1'
$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $operationName } | Select-Object -First 1
function Wait-Result($operation, [Type]$type) {
  $task = $extensions.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$writer = [Windows.Storage.Streams.DataWriter]::new($stream)
$writer.WriteBytes($data)
Wait-Result ($writer.StoreAsync()) ([uint32]) | Out-Null
$writer.DetachStream() | Out-Null
$writer.Dispose()
$stream.Seek(0)
$decoder = Wait-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
if ($decoder.PixelWidth -gt 2500 -or $decoder.PixelHeight -gt 2500) { exit 5 }
$bitmap = Wait-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-CN'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { exit 6 }
$result = Wait-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime])
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Write(($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine)
`;

export async function lifeOcr(body, signal) {
  if (process.platform !== 'win32') throw fault('当前主机没有 Windows OCR，请粘贴通知文字。',409);
  const image=body?.image;
  if(typeof image!=='string'||!image.length||image.length>LIFE_OCR_LIMIT-40||!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw fault('请选择有效的小尺寸截图。');
  const bytes=Buffer.from(image,'base64');
  if(!bytes.subarray(0,3).equals(Buffer.from([255,216,255]))&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fault('截图格式必须为 JPEG 或 PNG。');
  const ps = path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const args=['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  const output=await new Promise((resolve,reject)=>{
    const time=AbortSignal.timeout(15_000);
    const child=spawn(ps,args,{ windowsHide:true,signal:signal?AbortSignal.any([signal,time]):time,stdio:['pipe','pipe','ignore'] });
    let result='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{result+=chunk;if(result.length>20000)child.kill();});
    child.stdin.on('error',()=>{});
    child.once('error',()=>reject(fault('截图识别未完成，请粘贴通知或手工填写。',502)));
    child.once('close',code=>{
      if(code===6)reject(fault('Windows 尚无 OCR 语言包，请安装识别语言或粘贴通知。',409));
      else if(code!==0||!result.trim())reject(fault('未识别到可用文字，请更换截图或粘贴通知。',422));
      else resolve(result.trim().slice(0,4000));
    });
    child.stdin.end(image);
  });
  return { text:output };
}
