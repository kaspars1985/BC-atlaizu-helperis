<#
.SYNOPSIS
    BC atlaizu parvaldnieks - lokalais atjauninatajs (Load unpacked rezimam).

.DESCRIPTION
    Lejuplada jaunako GitHub laidiena .zip paketi un izpako to virsu pasreizejai
    paplasinajuma mapei. Pec tam paplasinajums pats pamana, ka diska ir jaunaka
    versija, un piedava vienu pogu "Parladet" (bez ZIP, bez edge://extensions).

.PARAMETER Target
    Paplasinajuma mape. Noklusejums: si skripta mapes virsmappe.

.PARAMETER Register
    Iesledz automatisku parbaudi katru reizi piesledzoties Windows.

.PARAMETER Unregister
    Izslegj automatisko parbaudi.

.PARAMETER CheckOnly
    Tikai parbauda, vai ir jaunaka versija - neko nemaina.

.PARAMETER ZipPath
    Izmanto lokalu .zip failu (bezmaksas/offline rezims, piem. no rokas lejuplades).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -CheckOnly

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Register
#>
[CmdletBinding()]
param(
    [string]$Target,
    [string]$Repo = "kaspars1985/BC-atlaizu-helperis",
    [string]$ZipPath,
    [switch]$Force,
    [switch]$CheckOnly,
    [switch]$Quiet,
    [switch]$Register,
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ScriptFile = $MyInvocation.MyCommand.Path
if (-not $ScriptFile) { $ScriptFile = Join-Path $ScriptDir "update.ps1" }
$LogFile = Join-Path $ScriptDir "update.log"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "BCAtlaizuHelperisAtjauninasana"
$StartupShortcutName = "BC atlaizu helperis - atjauninasana.lnk"
$IsLegacyPs = ($PSVersionTable.PSVersion.Major -lt 6)

# --------------------------------------------------------------------------
# Logosana
# --------------------------------------------------------------------------
function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
    if ($Quiet) { return }
    switch ($Level) {
        "ERROR" { Write-Host $Message -ForegroundColor Red }
        "WARN"  { Write-Host $Message -ForegroundColor Yellow }
        default { Write-Host $Message }
    }
}

# --------------------------------------------------------------------------
# Versiju salidzinasana
# --------------------------------------------------------------------------
function Get-VersionParts {
    param([string]$Version)
    $parts = @(0, 0, 0)
    if ([string]::IsNullOrWhiteSpace($Version)) { return $parts }
    $clean = $Version.Trim() -replace '^[vV]', ''
    $split = $clean.Split('.')
    for ($i = 0; $i -lt 3; $i++) {
        if ($i -lt $split.Length) {
            $digits = ($split[$i] -replace '[^0-9].*$', '')
            if ($digits -ne '') { $parts[$i] = [int]$digits }
        }
    }
    return $parts
}

function Test-NewerVersion {
    param([string]$Latest, [string]$Current)
    $l = Get-VersionParts $Latest
    $c = Get-VersionParts $Current
    for ($i = 0; $i -lt 3; $i++) {
        if ($l[$i] -gt $c[$i]) { return $true }
        if ($l[$i] -lt $c[$i]) { return $false }
    }
    return $false
}

function Read-ManifestVersion {
    param([string]$ManifestPath)
    if (-not (Test-Path -LiteralPath $ManifestPath)) { return "" }
    $json = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    return [string]$json.version
}

# --------------------------------------------------------------------------
# HTTP (saderigs gan ar PowerShell 5.1, gan 7)
# --------------------------------------------------------------------------
function Get-JsonFromUrl {
    param([string]$Uri)
    $params = @{
        Uri        = $Uri
        Headers    = @{
            "Accept"     = "application/vnd.github+json"
            "User-Agent" = "BC-atlaizu-helperis-updater"
        }
        TimeoutSec = 30
    }
    if ($IsLegacyPs) { $params["UseBasicParsing"] = $true }
    return Invoke-RestMethod @params
}

function Save-UrlToFile {
    param([string]$Uri, [string]$OutFile)
    $params = @{
        Uri        = $Uri
        OutFile    = $OutFile
        Headers    = @{
            "Accept"     = "application/octet-stream"
            "User-Agent" = "BC-atlaizu-helperis-updater"
        }
        TimeoutSec = 180
    }
    if ($IsLegacyPs) { $params["UseBasicParsing"] = $true }
    Invoke-WebRequest @params | Out-Null
}

# --------------------------------------------------------------------------
# Failu parsanasana
# --------------------------------------------------------------------------
function Copy-PackageFiles {
    param([string]$Source, [string]$Destination)
    $attempts = 3
    for ($i = 1; $i -le $attempts; $i++) {
        try {
            Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq $attempts) {
                throw "Neizdevas parrakstit failus (iespejams, parlukls tur tos vala). Aizver Edge/Chrome un palaid velreiz. Kluda: $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds 700
        }
    }
}

function Remove-StaleFiles {
    param([string]$Source, [string]$Destination)
    Get-ChildItem -LiteralPath $Destination -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($Destination.Length).TrimStart('\', '/')
        if ($relative -like "atjauninasana*" -or $relative -like ".git*") { return }
        if (-not (Test-Path -LiteralPath (Join-Path $Source $relative))) {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Log "Iznemts vecais fails: $relative"
        }
    }
    # Iztuksotas apakšmapes (iznemot atjauninasana)
    for ($pass = 0; $pass -lt 3; $pass++) {
        Get-ChildItem -LiteralPath $Destination -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
            $relative = $_.FullName.Substring($Destination.Length).TrimStart('\', '/')
            if ($relative -like "atjauninasana*" -or $relative -like ".git*") { return }
            if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                Write-Log "Iznemta tuksa mape: $relative"
            }
        }
    }
}

# --------------------------------------------------------------------------
# Automatiska palaisana pie pieslegsanas
# --------------------------------------------------------------------------
# NB: apzinati izmantota HKCU\...\Run atslega, nevis Starta mapes saissne -
# WScript.Shell saissnes saglabā argumentus ANSI kodējumā un ceļus ar
# diakritiku (piem. "palīgs") pārvērš par "paligs", tāpēc saissne nestrādā.
function Install-AutoStart {
    if (-not (Test-Path -LiteralPath $RunKeyPath)) {
        New-Item -Path $RunKeyPath -Force | Out-Null
    }
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = "powershell.exe" }
    $command = '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Quiet' -f $psExe, $ScriptFile
    New-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value $command -PropertyType String -Force | Out-Null
    return $command
}

function Remove-AutoStart {
    $removed = $false
    if (Test-Path -LiteralPath $RunKeyPath) {
        $existing = Get-ItemProperty -Path $RunKeyPath -Name $RunValueName -ErrorAction SilentlyContinue
        if ($existing -and $existing.PSObject.Properties[$RunValueName]) {
            Remove-ItemProperty -Path $RunKeyPath -Name $RunValueName -Force -ErrorAction SilentlyContinue
            $removed = $true
        }
    }
    # Vecā starta saissne (no iepriekšējām versijām)
    $legacyLnk = Join-Path ([Environment]::GetFolderPath("Startup")) $StartupShortcutName
    if (Test-Path -LiteralPath $legacyLnk) {
        Remove-Item -LiteralPath $legacyLnk -Force -ErrorAction SilentlyContinue
        $removed = $true
    }
    return $removed
}

# --------------------------------------------------------------------------
# Galvena logika
# --------------------------------------------------------------------------
function Invoke-Update {
    if (-not $Target) { $Target = Split-Path -Parent $ScriptDir }
    $script:TargetPath = [System.IO.Path]::GetFullPath($Target)

    Write-Log "--- Atjauninasana sakas (merka mape: $script:TargetPath) ---"

    if (-not $CheckOnly -and (Test-Path -LiteralPath (Join-Path $script:TargetPath ".git")) -and -not $Force) {
        Write-Log "Merka mape izskatas pec izstrades repozitorija (.git). Lai neiznicinatu avota kodu, atjauninasana aptureta. Ja taa tiešam ir paplasinajuma mape - palaid ar -Force." "ERROR"
        return 1
    }

    if (-not (Test-Path -LiteralPath $script:TargetPath)) {
        New-Item -ItemType Directory -Path $script:TargetPath -Force | Out-Null
        Write-Log "Izveidota mape $script:TargetPath"
    }

    $currentVersion = Read-ManifestVersion (Join-Path $script:TargetPath "manifest.json")
    if ($currentVersion) { Write-Log "Uzstadita versija: v$currentVersion" }
    else { Write-Log "Uzstadita versija: nav (pirmā uzstadisana)" }

    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bcm-update-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

    try {
        $zipFile = $null
        $remoteVersion = ""

        if ($ZipPath) {
            if (-not (Test-Path -LiteralPath $ZipPath)) {
                Write-Log "Noraditais paketes fails neeksiste: $ZipPath" "ERROR"
                return 1
            }
            $zipFile = (Resolve-Path -LiteralPath $ZipPath).Path
            Write-Log "Izmanto lokalo paketi: $zipFile"
        } else {
            Write-Log "Parbaudu jaunako laidienu: https://github.com/$Repo/releases/latest"
            try {
                $release = Get-JsonFromUrl "https://api.github.com/repos/$Repo/releases/latest"
            } catch {
                Write-Log "Nevaru nolasit GitHub laidienu: $($_.Exception.Message)" "ERROR"
                return 1
            }

            $remoteVersion = ([string]$release.tag_name) -replace '^[vV]', ''
            $asset = $null
            if ($release.assets) {
                $asset = $release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
            }
            if (-not $asset) {
                Write-Log "Laidienam 'v$remoteVersion' nav .zip faila - nekas nav jadara." "WARN"
                return 1
            }

            Write-Log "Jaunakais laidiens: v$remoteVersion"

            if ($currentVersion -and -not (Test-NewerVersion $remoteVersion $currentVersion)) {
                if ($CheckOnly) {
                    Write-Log "Nav jaunakas versijas (uzstadita v$currentVersion, GitHub jaunakais v$remoteVersion)."
                } else {
                    Write-Log "Jau ir jaunaka versija (v$currentVersion). Nekas nav jadara."
                }
                return 0
            }

            if ($CheckOnly) {
                $shownCurrent = if ($currentVersion) { "v$currentVersion" } else { "nav uzstadita" }
                Write-Log "Pieejama jaunaka versija: v$remoteVersion (uzstadita: $shownCurrent) - $($asset.browser_download_url)"
                return 0
            }

            $zipFile = Join-Path $tmpRoot "pakete.zip"
            Write-Log "Lejupladeju paketi ($([math]::Round($asset.size / 1024)) KB)..."
            Save-UrlToFile $asset.browser_download_url $zipFile
        }

        $extractDir = Join-Path $tmpRoot "pakete"
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force

        $pkgManifest = Join-Path $extractDir "manifest.json"
        if (-not (Test-Path -LiteralPath $pkgManifest)) {
            $nested = Get-ChildItem -LiteralPath $extractDir -Filter "manifest.json" -Recurse -File | Select-Object -First 1
            if ($nested) {
                $extractDir = $nested.Directory.FullName
                $pkgManifest = $nested.FullName
            }
        }
        if (-not (Test-Path -LiteralPath $pkgManifest)) {
            Write-Log "Pakete nesatur manifest.json - partraucu." "ERROR"
            return 1
        }

        $pkgVersion = Read-ManifestVersion $pkgManifest
        Write-Log "Paketes versija: v$pkgVersion"

        if ($remoteVersion -and $pkgVersion -and ($pkgVersion -ne $remoteVersion)) {
            Write-Log "Uzmanibu: paketes manifesta versija ($pkgVersion) atskiras no laidiena tag ($remoteVersion). Turpinu." "WARN"
        }

        if ($currentVersion -and -not (Test-NewerVersion $pkgVersion $currentVersion) -and -not $Force) {
            Write-Log "Pakete nav jaunaka par uzstadito (v$currentVersion). Nekas nav jamaina."
            return 0
        }

        if ($CheckOnly) {
            Write-Log "Pakete ir jaunaka (v$pkgVersion) - ar -CheckOnly neko nemainu."
            return 0
        }

        Write-Log "Parrasktu failus mape $script:TargetPath ..."
        Copy-PackageFiles -Source $extractDir -Destination $script:TargetPath
        Remove-StaleFiles -Source $extractDir -Destination $script:TargetPath

        $installedVersion = Read-ManifestVersion (Join-Path $script:TargetPath "manifest.json")
        Write-Log "Gatavs! Uzstadita versija: v$installedVersion"
        Write-Log "Paplasinajums to uzreiz izmantos pec tam, kad atversi atlaizu logu (Alt+D) un nospiedisi 'Parladet tagad'."
        return 0
    } finally {
        Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --------------------------------------------------------------------------
# Ieejas punkts
# --------------------------------------------------------------------------
if ($Unregister) {
    if (Remove-AutoStart) {
        Write-Log "Automatiska atjauninasana izslegta."
    } else {
        Write-Log "Automatiska atjauninasana nav ieslegta - nekas nav jaizsleg."
    }
    exit 0
}

if ($Register) {
    $command = Install-AutoStart
    Write-Log "Automatiska atjauninasana ieslegta."
    Write-Log "Registrs: HKCU\Software\Microsoft\Windows\CurrentVersion\Run -> $RunValueName"
    Write-Log "Komanda: $command"
    Write-Log "Parbaude notiks katra Windows pieslegsanas reize (klusi, fona)."
}

$exitCode = 1
try {
    $exitCode = Invoke-Update
} catch {
    Write-Log "Atjauninasana neizdevas: $($_.Exception.Message)" "ERROR"
    $exitCode = 1
}

Write-Log "--- Beigas (kods $exitCode) ---"
exit $exitCode
