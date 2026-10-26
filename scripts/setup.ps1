param([switch]$IncludeQqDependencies, [switch]$BuildOriginalWeFlow)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Project config preparation failed.' }
& $node (Join-Path $PSScriptRoot 'prepare-python.mjs') --configure
if ($LASTEXITCODE -ne 0) { throw 'Automatic runtime preparation failed. Retry the prepare environment button; no Python path is required.' }
function Install-Npm([string]$Directory,[bool]$Legacy) {
    Push-Location $Directory
    try {
        $arguments = @('ci','--ignore-scripts','--no-audit','--no-fund','--prefer-offline')
        if ($Legacy) { $arguments += '--legacy-peer-deps' }
        & npm.cmd @arguments
        if ($LASTEXITCODE -ne 0) { throw ('npm ci failed in '+$Directory) }
    } finally { Pop-Location }
}
Install-Npm (Join-Path $root 'packages\dsh-social-bridge-plugin') $false
if ($BuildOriginalWeFlow) { throw 'The public source does not include historical WeFlow Desktop. Use the independent desktop build dependencies.' }
if ($IncludeQqDependencies) { Install-Npm (Join-Path $root 'components\qq-bridge') $false }
Write-Output ('Install the local plugin in DSH Desktop: '+(Join-Path $root 'packages\dsh-social-bridge-plugin'))
Write-Output 'Dependencies installed. For WeChat-Hook, build the native component and prepare the matching client as described in docs/WECHAT_HOOK.md. Then start WeChatAgent.cmd.'
