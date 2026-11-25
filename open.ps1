param([switch]$KeySettings)
$ErrorActionPreference = 'Stop'
$folioUrl = 'http://127.0.0.1:43827'
function Test-Folio {
    $response = $null
    try {
        # The workbench is on loopback even when model traffic uses a proxy.
        $request = [System.Net.WebRequest]::Create("$folioUrl/api/boot")
        $request.Proxy = $null
        $request.Method = 'POST'
        $request.Headers['X-Folio'] = '1'
        $request.ContentLength = 0
        $request.Timeout = 2000
        $response = $request.GetResponse()
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
        try { $reply = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        return $null -ne $reply.models.Claude
    } catch { return $false } finally { if ($response) { $response.Dispose() } }
}
if (-not (Test-Folio)) {
    $nodeExe = (Get-Command node.exe).Source
    $worker = Start-Process -FilePath $nodeExe -WorkingDirectory $PSScriptRoot -ArgumentList '--use-system-ca','--use-env-proxy','server.mjs' -WindowStyle Hidden -PassThru
    for ($count = 0; $count -lt 20; $count++) {
        Start-Sleep -Milliseconds 250
        if (Test-Folio) { break }
        if ($worker.HasExited) { throw "Folio could not start. Run node server.mjs in this folder for details." }
    }
    if (-not (Test-Folio)) { throw "Folio did not respond on port 43827." }
}
if ($KeySettings) { Start-Process "$folioUrl/#openrouter" } else { Start-Process $folioUrl }
