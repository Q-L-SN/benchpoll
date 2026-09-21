#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateSet('Validate','CheckQuota','Preflight','Run','RunOnce','Report')]
    [string]$Mode = 'Validate',
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'globalping-monitor.config.json'),
    [switch]$Library
)

$ErrorActionPreference = 'Stop'
$script:ApiBase = 'https://api.globalping.io/v1'

function Read-JsonFile([string]$Path) {
    ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)) -AsHashtable -Depth 100
}
function Write-AtomicJson([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    [void][IO.Directory]::CreateDirectory($parent)
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 100), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
}
function Get-SeriesId($Config) {
    $data = @{ targets=$Config.targets; timeout=$Config.timeoutSeconds; windows=$Config.windows; schema=1 } | ConvertTo-Json -Depth 30 -Compress
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($data))).Substring(0,16).ToLowerInvariant()
}
function Get-ConfigIssues($Config) {
    if ($Config.schemaVersion -ne 1) { 'Unsupported schemaVersion.' }
    if (@($Config.targets).Count -ne 3) { 'Exactly three targets are required.' }
    if (@($Config.targets.id | Select-Object -Unique).Count -ne 3) { 'Target IDs must be unique.' }
    if ($Config.timeoutSeconds -lt 5 -or $Config.timeoutSeconds -gt 30) { 'timeoutSeconds must be 5..30.' }
    if ($Config.windowBudget -lt 3 -or $Config.windowBudget -gt 450) { 'windowBudget must be 3..450 (free-only policy).' }
    if ($Config.freeReserve -lt 50) { 'freeReserve must be at least 50.' }
    if ($Config.roundIntervalSeconds -lt 60 -or $Config.pollIntervalSeconds -lt 1) { 'Sampling/poll intervals are too short.' }
    if ($Config.requireZeroCreditBalance -ne $true) { 'requireZeroCreditBalance must remain true; paid-credit use is not implemented.' }
    try { [void][TimeZoneInfo]::FindSystemTimeZoneById($Config.timeZone) } catch { 'Unknown time zone.' }
    foreach ($target in $Config.targets) {
        $u = $null
        if (![Uri]::TryCreate([string]$target.url, [UriKind]::Absolute, [ref]$u) -or $u.Scheme -ne 'https' -or $u.HostNameType -ne [UriHostNameType]::Dns -or $u.UserInfo -or $u.Query -or $u.Fragment) {
            "$($target.id): supply a public HTTPS hostname URL, without credentials, query or fragment."
        }
        if ($target.id -notmatch '^[a-z0-9-]+$') { 'Target IDs may contain lowercase letters, numbers and hyphens only.' }
        if (!$target.regionVerified -or @($target.allowedIps).Count -eq 0) { "$($target.id): verify region and supply allowedIps for the actual instance (no CDN)." }
        foreach ($ip in $target.allowedIps) {
            $parsed = $null
            if (![Net.IPAddress]::TryParse($ip, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { "$($target.id): allowedIps must be IPv4 addresses." }
        }
        if ($target.expectedStatus -lt 200 -or $target.expectedStatus -ge 300) { "$($target.id): expectedStatus must be 2xx." }
        if ([string]::IsNullOrWhiteSpace($target.expectedBody) -or [Text.Encoding]::UTF8.GetByteCount($target.expectedBody) -gt 1000) { "$($target.id): supply a fixed non-secret response body of at most 1000 UTF-8 bytes." }
    }
    if (@($Config.targets.expectedBody | Select-Object -Unique).Count -ne 1) { 'All targets must return the same expectedBody.' }
    if (@($Config.targets.expectedStatus | Select-Object -Unique).Count -ne 1) { 'All targets must use the same expectedStatus.' }
    if (@($Config.windows).Count -eq 0) { 'No sampling windows configured.' }
    if (@($Config.windows.id | Select-Object -Unique).Count -ne @($Config.windows).Count) { 'Window IDs must be unique.' }
    $hours = @{}
    foreach ($window in $Config.windows) {
        if ($window.id -notmatch '^[a-z0-9-]+$') { 'Invalid window ID.' }
        if ($window.startHour -lt 0 -or $window.startHour -gt 23 -or $window.durationHours -lt 1 -or $window.durationHours -gt 3) { 'Invalid window hours.' }
        for ($i=0; $i -lt $window.durationHours; $i++) {
            $h = ([int]$window.startHour + $i) % 24
            if ($hours.ContainsKey($h)) { 'Sampling windows must not overlap.' }
            $hours[$h] = $true
        }
        if (@($window.locations).Count -eq 0) { "$($window.id): no locations." }
        foreach ($l in $window.locations) {
            if ($l.country -notmatch '^[A-Z]{2}$' -or $l.asn -lt 1) { 'Every location requires a country and ASN.' }
        }
    }
}
function Get-ActiveWindow($Config, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow) {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($Config.timeZone)
    $local = [TimeZoneInfo]::ConvertTime($Now, $zone)
    foreach ($window in $Config.windows) {
        foreach ($offset in @(0,-1)) {
            $startLocal = [DateTime]::SpecifyKind($local.Date.AddDays($offset).AddHours($window.startHour), [DateTimeKind]::Unspecified)
            $start = [DateTimeOffset]::new([TimeZoneInfo]::ConvertTimeToUtc($startLocal, $zone))
            $end = $start.AddHours($window.durationHours)
            if ($Now -ge $start -and $Now -lt $end) {
                return @{ key=($startLocal.ToString('yyyy-MM-dd') + '_' + $window.id); date=$startLocal.ToString('yyyy-MM-dd'); start=$start.ToString('o'); end=$end.ToString('o'); definition=$window }
            }
        }
    }
    return $null
}
function New-MeasurementBody($Target, $Locations, [int]$Count, [int]$Timeout) {
    $u = [Uri]$Target.url
    $body = @{ type='http'; target=$u.DnsSafeHost; timeout=$Timeout; measurementOptions=@{ protocol='HTTPS'; port=$u.Port; ipVersion=4; request=@{ method='GET'; path=$u.AbsolutePath; headers=@{ 'Cache-Control'='no-cache' } } }; locations=$Locations }
    if ($Locations -is [string]) { $body.limit=$Count }
    return $body
}
function Get-ProbeSignature($Probe) {
    @($Probe.country, $Probe.asn, $Probe.city, $Probe.latitude, $Probe.longitude, (($Probe.tags | Sort-Object) -join ',')) -join '|'
}
function Get-Classification($Result, $Target, [int]$Timeout) {
    if ($Result.status -eq 'offline' -or $Result.failureSource -eq 'internal') { return @{ eligible=$false; reason='probe-unavailable'; success=$false } }
    if ($Result.status -notin @('finished','failed')) { return @{ eligible=$false; reason='unknown-probe-status'; success=$false } }
    $reason = 'ok'
    if ($Result.status -eq 'failed') {
        if ($Result.failureSource -eq 'resolver') { $reason='dns' }
        elseif ([string]$Result.rawOutput -match '(?i)timed?\s*out|timeout') { $reason='timeout' }
        else { $reason='connection-or-target-error' }
    } elseif ($Result.tls.authorized -ne $true) { $reason='tls-invalid-or-missing' }
    elseif ($Target.allowedIps -notcontains $Result.resolvedAddress) { $reason='unexpected-endpoint-ip' }
    elseif ($Result.statusCode -eq 429) { $reason='http-429' }
    elseif ($Result.statusCode -ne $Target.expectedStatus) { $reason='http-status' }
    elseif ($Result.truncated) { $reason='truncated-response' }
    elseif ([string]$Result.rawBody -cne [string]$Target.expectedBody) { $reason='body-mismatch' }
    elseif ($null -eq $Result.timings.total) { return @{eligible=$false; reason='missing-timing'; success=$false} }
    elseif ([double]$Result.timings.total -gt $Timeout*1000) { $reason='timeout' }
    return @{ eligible=$true; reason=$reason; success=($reason -eq 'ok') }
}
function Get-Statistics($Rows) {
    $n = @($Rows).Count
    $failed = @($Rows | Where-Object { !$_.success }).Count
    $times = @($Rows | Where-Object { $_.success -and $null -ne $_.totalMs } | ForEach-Object { [double]$_.totalMs } | Sort-Object)
    $median=$null; $p95=$null; $p99=$null
    if ($times.Count) {
        $median=($times[[int][Math]::Floor(($times.Count-1)/2)] + $times[[int][Math]::Floor($times.Count/2)])/2
        $p95=$times[[int][Math]::Ceiling(.95*$times.Count)-1]; $p99=$times[[int][Math]::Ceiling(.99*$times.Count)-1]
    }
    $upper=$null
    if ($n -gt 0 -and $failed -eq 0) { $upper=100*(1-[Math]::Pow(.05,1.0/$n)) }
    return @{ n=$n; failed=$failed; failurePct=$(if($n){100.0*$failed/$n}else{$null}); medianMs=$median; p95Ms=$p95; p99Ms=$p99;
        slow1s=@($Rows | Where-Object { $_.success -and $_.totalMs -ge 1000 }).Count;
        slow2s=@($Rows | Where-Object { $_.success -and $_.totalMs -ge 2000 }).Count;
        zeroFailureOneSided95UpperPct=$upper }
}
function Invoke-GpApi([string]$Path, [string]$Method='GET', $Body=$null) {
    $args = @{ Uri=($script:ApiBase+$Path); Method=$Method; Headers=$script:AuthHeaders; TimeoutSec=35; MaximumRedirection=0; SkipHttpErrorCheck=$true; ErrorAction='Stop' }
    if ($null -ne $Body) { $args.Body=ConvertTo-Json -InputObject $Body -Depth 30 -Compress; $args.ContentType='application/json' }
    try { $response=Invoke-WebRequest @args } catch { throw 'API transport error; credentials and response details suppressed.' }
    $status=[int]$response.StatusCode
    if ($status -lt 200 -or $status -ge 300) {
        $errorObject=[Exception]::new("Globalping API HTTP $status."); $errorObject.Data['Status']=$status; throw $errorObject
    }
    try { $data=ConvertFrom-Json -InputObject $response.Content -AsHashtable -Depth 100 } catch { throw 'API response was not valid JSON.' }
    return @{ data=$data; headers=$response.Headers }
}
function Get-FreeQuota {
    $data=(Invoke-GpApi '/limits').data
    $q=$data.rateLimit.measurements.create
    if ($q.type -ne 'user') { throw 'Member authentication not confirmed (quota type is not user).' }
    if ($null -eq $q.remaining -or $null -eq $q.limit) { throw 'Unrecognized quota response; stopped safely.' }
    # Globalping auto-spends credits when free quota is exceeded. No documented no-spend flag exists.
    # Refuse any positive balance in this free-only version, and retain a free-quota reserve.
    if ($null -eq $data.credits.remaining) { throw 'Cannot verify credit balance; free-only safety gate blocked.' }
    if ([double]$data.credits.remaining -gt 0) { throw 'Credit balance is positive. Free-only safety gate refuses to run; do not spend credits automatically.' }
    return $q
}
function Test-Endpoints($Config) {
    $handler=[Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect=$false; $handler.UseProxy=$false
    $client=[Net.Http.HttpClient]::new($handler); $client.Timeout=[TimeSpan]::FromSeconds($Config.timeoutSeconds)
    try {
        foreach ($target in $Config.targets) {
            $u=[Uri]$target.url
            $ips=@([Net.Dns]::GetHostAddresses($u.DnsSafeHost) | Where-Object AddressFamily -eq InterNetwork | ForEach-Object ToString)
            if (!$ips.Count -or @($ips | Where-Object { $target.allowedIps -notcontains $_ }).Count) { throw "Preflight $($target.id): unexpected DNS/IPv4 address." }
            try { $response=$client.GetAsync($u, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult() } catch { throw "Preflight $($target.id): HTTPS/TLS failed from local computer (not a probe result)." }
            try {
                if ([int]$response.StatusCode -ne $target.expectedStatus) { throw "Preflight $($target.id): unexpected HTTP status." }
                $cts=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($Config.timeoutSeconds))
                try {
                    $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                    $buffer=[byte[]]::new(10001); $length=0
                    do { $read=$stream.ReadAsync($buffer,$length,$buffer.Length-$length,$cts.Token).GetAwaiter().GetResult(); $length+=$read } while($read -gt 0 -and $length -lt $buffer.Length)
                    if ($length -gt 10000 -or [Text.Encoding]::UTF8.GetString($buffer,0,$length) -cne $target.expectedBody) { throw "Preflight $($target.id): unexpected/oversized body." }
                } finally { $cts.Dispose() }
            } finally { $response.Dispose() }
            Write-Host "Preflight OK: $($target.id) (local check, excluded from measurements)."
        }
    } finally { $client.Dispose(); $handler.Dispose() }
}
function Get-Locations($Window) {
    $inventory=(Invoke-GpApi '/probes').data
    $selected=@(); $missing=@()
    foreach ($wanted in $Window.locations) {
        $matches=@($inventory | Where-Object {
            $_.location.country -eq $wanted.country -and $_.location.asn -eq $wanted.asn -and $_.tags -contains 'eyeball-network' -and (!$wanted.city -or $_.location.city -eq $wanted.city)
        })
        if (!$matches.Count) { $missing += ($wanted | ConvertTo-Json -Compress); continue }
        $loc=@{country=$wanted.country;asn=$wanted.asn;tags=@('eyeball-network');limit=1}
        if($wanted.city){$loc.city=$wanted.city}
        $selected += $loc
    }
    return @{ selected=$selected; missing=$missing }
}
function Get-PointCost($Round) {
    if ($Round.seedCount -gt 0) { return [int]$Round.seedCount }
    return @($Round.locations).Count
}
function Save-State { Write-AtomicJson (Join-Path $script:SeriesRoot 'state.json') $script:MonitorState }
function Get-RawPath([string]$Id) {
    if ($Id -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid measurement ID.' }
    Join-Path $script:SeriesRoot "raw/$Id.json"
}
function Receive-Measurement([string]$Id) {
    $path=Get-RawPath $Id
    if (Test-Path -LiteralPath $path) { return Read-JsonFile $path }
    $until=[DateTimeOffset]::UtcNow.AddSeconds(90)
    while([DateTimeOffset]::UtcNow -lt $until) {
        $m=(Invoke-GpApi "/measurements/$Id").data
        if($m.status -ne 'in-progress') { Write-AtomicJson $path $m; return $m }
        Start-Sleep -Seconds $script:MonitorConfig.pollIntervalSeconds
    }
    throw "Measurement still pending: $Id. Restart to retrieve it without resubmitting."
}
function Complete-Round($Round) {
    $measurements=@{}
    foreach($target in $script:MonitorConfig.targets) { $measurements[$target.id]=Read-JsonFile (Get-RawPath $Round.requests[$target.id].id) }
    $anchor=$measurements[$Round.order[0]]
    $rows=@()
    $end=[DateTimeOffset]$Round.end
    $within=$true
    foreach($m in $measurements.Values) { if([DateTimeOffset]$m.createdAt -lt [DateTimeOffset]$Round.start -or [DateTimeOffset]$m.updatedAt -ge $end){$within=$false} }
    # Raw observations remain available even when pairing excludes a probe on all three targets.
    for($i=0;$i -lt @($anchor.results).Count;$i++) {
        $signature=Get-ProbeSignature $anchor.results[$i].probe
        $paired=$within; $classified=@{}
        foreach($target in $script:MonitorConfig.targets) {
            $results=@($measurements[$target.id].results)
            if($i -ge $results.Count){$paired=$false;continue}
            $item=$results[$i]
            $validSource=$false
            foreach($l in $Round.locations){if($l.country -eq $item.probe.country -and $l.asn -eq $item.probe.asn -and (!$l.city -or $l.city -eq $item.probe.city)){$validSource=$true}}
            $classification=Get-Classification $item.result $target $script:MonitorConfig.timeoutSeconds
            if((Get-ProbeSignature $item.probe) -ne $signature -or !$classification.eligible -or !$validSource -or $item.probe.tags -notcontains 'eyeball-network'){$paired=$false}
            $classified[$target.id]=@{item=$item;classification=$classification;sourceValid=$validSource}
        }
        foreach($target in $script:MonitorConfig.targets) {
            if(!$classified.ContainsKey($target.id)){continue}
            $c=$classified[$target.id];$p=$c.item.probe;$r=$c.item.result
            $market=if($p.country -in @('DE','GB','FR')){'Europe'}else{$p.country}
            $rows+=@{ window=$Round.window; date=$Round.date; round=$Round.number; target=$target.id; measurementId=$Round.requests[$target.id].id;
                createdAt=$measurements[$target.id].createdAt; country=$p.country; market=$market; city=$p.city; asn=$p.asn; probeSignature=(Get-ProbeSignature $p);
                paired=$paired; withinWindow=$within; eligible=$c.classification.eligible; sourceValid=$c.sourceValid; success=$c.classification.success; reason=$c.classification.reason;
                totalMs=$r.timings.total; dnsMs=$r.timings.dns; tcpMs=$r.timings.tcp; tlsMs=$r.timings.tls; firstByteWaitMs=$r.timings.firstByte; downloadMs=$r.timings.download }
        }
    }
    Write-AtomicJson (Join-Path $script:SeriesRoot "rounds/$($Round.key).json") @{round=$Round;observations=$rows}
    $Round.status='complete';Save-State
    Write-Host "Completed $($Round.key): paired observations $(@($rows | Where-Object paired).Count); exclusions $(@($rows | Where-Object { !$_.paired }).Count)."
}
function Invoke-Round($Round, [bool]$AllowSubmit) {
    foreach($targetId in $Round.order) {
        $target=@($script:MonitorConfig.targets | Where-Object id -eq $targetId)[0]
        if(!$Round.requests.ContainsKey($targetId)) {
            if(!$AllowSubmit -or [DateTimeOffset]::UtcNow -ge ([DateTimeOffset]$Round.end).AddSeconds(-30)){return}
            $q=Get-FreeQuota; $cost=Get-PointCost $Round
            if($q.remaining -lt ($cost+$script:MonitorConfig.freeReserve)){return}
            $locations=if($Round.seedId){$Round.seedId}else{$Round.locations}
            $request=New-MeasurementBody $target $locations $cost $script:MonitorConfig.timeoutSeconds
            # Persist intent BEFORE POST. A crash/timeout here is ambiguous, never auto-retry it.
            $Round.requests[$targetId]=@{status='submitting';id=$null;estimatedCost=$cost;submittedAt=[DateTimeOffset]::UtcNow.ToString('o')}
            Save-State
            try { $response=Invoke-GpApi '/measurements' 'POST' $request } catch {
                $code=$_.Exception.Data['Status']
                if($code -in @(400,401,403,422,429)) { $Round.requests[$targetId].status='rejected';$Round.requests[$targetId].httpStatus=$code }
                else { $Round.requests[$targetId].status='ambiguous' }
                Save-State; throw "Submission stopped ($targetId). See state.json; never blindly resubmit an ambiguous request."
            }
            $id=[string]$response.data.id
            if($id -notmatch '^[a-zA-Z0-9_-]+$'){throw 'Missing measurement ID; persisted submitting intent prevents duplicate POST.'}
            $entry=$Round.requests[$targetId];$entry.id=$id;$entry.status='submitted';$entry.cost=[int]$response.data.probesCount
            $script:MonitorState.windows[$Round.window].spent += $entry.cost
            if(!$Round.seedId){$Round.seedId=$id;$Round.seedCount=$entry.cost}
            Save-State
            Write-Host "POSTED $($Round.key) $targetId $id probes=$($entry.cost)"
            if($response.headers['X-Credits-Consumed'] -and [int](@($response.headers['X-Credits-Consumed'])[0]) -gt 0){throw 'Unexpected credit consumption: stopped immediately.'}
        }
        $entry=$Round.requests[$targetId]
        if($entry.status -in @('submitting','ambiguous','rejected')) { throw "Unresolved submission for $targetId in $($Round.key). Manual review required; no duplicate request sent." }
        if($entry.status -eq 'submitted') {
            [void](Receive-Measurement $entry.id);$entry.status='received';Save-State
        }
    }
    if(@($Round.requests.Values | Where-Object status -eq 'received').Count -eq 3){Complete-Round $Round}
}
function Write-Reports {
    $all=@();$coverage=@()
    foreach($file in @(Get-ChildItem -LiteralPath (Join-Path $script:SeriesRoot 'rounds') -Filter '*.json' -ErrorAction SilentlyContinue)) {
        $record=Read-JsonFile $file.FullName; $all+=@($record.observations)
        $coverage+=@{window=$record.round.window;round=$record.round.number;missingLocations=$record.round.missing;requestedLocations=$record.round.locations}
    }
    $summaries=@()
    $usable=@($all | Where-Object { $_.paired })
    foreach($scope in @('cumulative','daily')) {
        foreach($dimension in @('market','country','operator','probe')) {
            $groups=@{}
            foreach($r in $usable) {
                $label=switch($dimension){'market'{$r.market}'country'{$r.country}'operator'{"$($r.country)-AS$($r.asn)"}'probe'{$r.probeSignature}}
                $day=if($scope -eq 'daily'){$r.date}else{'all'}
                # Keep east/west and peak groups separate even in cumulative output.
                $windowGroup=$r.window.Substring(11)
                $key="$day|$windowGroup|$($r.target)|$label"
                if(!$groups.ContainsKey($key)){$groups[$key]=[Collections.Generic.List[object]]::new()}
                $groups[$key].Add($r)
            }
            foreach($key in ($groups.Keys | Sort-Object)) {
                $parts=$key -split '\|',4
                $stats=Get-Statistics $groups[$key].ToArray()
                $stats.scope=$scope;$stats.date=$parts[0];$stats.windowGroup=$parts[1];$stats.target=$parts[2];$stats.dimension=$dimension;$stats.label=$parts[3]
                $stats.days=@($groups[$key].date | Select-Object -Unique).Count
                $stats.goal=$script:MonitorConfig.dailyRequestsPerTargetPerMarketGoal
                $stats.goalReached=($stats.n -ge $stats.goal)
                $stats.evidence=if($stats.days -lt 3 -or !$stats.goalReached){'insufficient'}else{'preliminary; repeated samples are correlated'}
                $summaries+=$stats
            }
        }
    }
    $report=@{ generatedAt=[DateTimeOffset]::UtcNow.ToString('o'); series=$script:SeriesId; metrics='Globalping HTTPS synthetic GET; valid TLS/body/IP required; not BenchPoll business transactions';
        warning='Percentiles use successful requests only; always read failure counts alongside them. Zero-failure upper bound assumes independent identical trials and is optimistic for repeated probes. Missing coverage is not success.';
        observations=$all.Count; excluded=@($all | Where-Object { !$_.paired }).Count; coverage=$coverage; windows=$script:MonitorState.windows; summaries=$summaries }
    Write-AtomicJson (Join-Path $script:SeriesRoot 'report.json') $report
    $lines=@('# Globalping HTTPS report', '', "Updated UTC: $($report.generatedAt)", '', $report.warning, '', '| Scope | Date | Window | Target | Market | n | Failed | Failure % | Median ms | P95 ms | P99 ms | >=1s |', '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|')
    foreach($s in @($summaries | Where-Object dimension -eq 'market')) {
        $lines+="| $($s.scope) | $($s.date) | $($s.windowGroup) | $($s.target) | $($s.label) | $($s.n) | $($s.failed) | $([Math]::Round($s.failurePct,3)) | $($s.medianMs) | $($s.p95Ms) | $($s.p99Ms) | $($s.slow1s) |"
    }
    $lines+=@('', 'See report.json for operator/probe breakdown, missing locations, actual budgets and excluded observations. No automatic provider winner or long-term pass is inferred.')
    $path=Join-Path $script:SeriesRoot 'report.md';$tmp=$path+'.tmp'
    [IO.File]::WriteAllLines($tmp,$lines,[Text.UTF8Encoding]::new($false));[IO.File]::Move($tmp,$path,$true)
}
function Start-Monitor($Config) {
    $script:MonitorConfig=$Config;$script:SeriesId=Get-SeriesId $Config
    $root=if($Config.outputDirectory){[IO.Path]::GetFullPath($Config.outputDirectory)}else{Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'BenchPollGlobalping'}
    [void][IO.Directory]::CreateDirectory($root)
    $lock=$null
    try { $lock=[IO.File]::Open((Join-Path $root 'monitor.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { throw 'Another monitor is using this output directory.' }
    try {
        $script:SeriesRoot=Join-Path $root $script:SeriesId
        foreach($name in @('raw','rounds')){[void][IO.Directory]::CreateDirectory((Join-Path $script:SeriesRoot $name))}
        $statePath=Join-Path $script:SeriesRoot 'state.json'
        $script:MonitorState=if(Test-Path -LiteralPath $statePath){Read-JsonFile $statePath}else{@{series=$script:SeriesId;windows=@{};rounds=@()}}
        if($script:MonitorState.series -ne $script:SeriesId){throw 'State/config series mismatch.'}
        if($Mode -eq 'Report'){Write-Reports;Write-Host "Report: $script:SeriesRoot";return}
        [void](Get-FreeQuota)
        # Recover POST receipts first, including interrupted windows, before local endpoint preflight.
        foreach($round in $script:MonitorState.rounds){if($round.status -eq 'pending'){Invoke-Round $round $false}}
        Test-Endpoints $Config
        Write-Host "Running independently of Codex. Ctrl+C stops safely. Output: $script:SeriesRoot"
        while($true) {
            $active=Get-ActiveWindow $Config
            foreach($round in $script:MonitorState.rounds) {
                if($round.status -eq 'pending') {
                    $canSubmit=($null -ne $active -and $round.window -eq $active.key)
                    Invoke-Round $round $canSubmit
                    if(!$canSubmit -and $round.status -eq 'pending'){$round.status='expired-incomplete';Save-State}
                }
            }
            if($null -ne $active) {
                if(!$script:MonitorState.windows.ContainsKey($active.key)){$script:MonitorState.windows[$active.key]=@{spent=0;roundCount=0;lastRoundAt=$null};Save-State}
                $w=$script:MonitorState.windows[$active.key]
                $pending=@($script:MonitorState.rounds | Where-Object { $_.window -eq $active.key -and $_.status -eq 'pending' })
                $elapsed=if($w.lastRoundAt){([DateTimeOffset]::UtcNow-[DateTimeOffset]$w.lastRoundAt).TotalSeconds}else{1e9}
                if(!$pending.Count -and $elapsed -ge $Config.roundIntervalSeconds -and [DateTimeOffset]::UtcNow -lt ([DateTimeOffset]$active.end).AddMinutes(-2)) {
                    $locs=Get-Locations $active.definition;$count=@($locs.selected).Count;$q=Get-FreeQuota
                    if($count -gt 0 -and $w.spent+3*$count -le $Config.windowBudget -and $q.remaining -ge (3*$count+$Config.freeReserve)) {
                        $number=[int]$w.roundCount+1;$order=@();for($j=0;$j -lt 3;$j++){$order+=$Config.targets[($j+$number-1)%3].id}
                        $round=@{key=($active.key+'_'+$number.ToString('D4'));window=$active.key;date=$active.date;number=$number;start=$active.start;end=$active.end;status='pending';
                            locations=$locs.selected;missing=$locs.missing;order=$order;requests=@{};seedId=$null;seedCount=0}
                        $script:MonitorState.rounds+=,$round;$w.roundCount=$number;$w.lastRoundAt=[DateTimeOffset]::UtcNow.ToString('o');Save-State
                        Invoke-Round $round $true
                    } else { Write-Host "Waiting: $($active.key), remaining=$($q.remaining), windowSpent=$($w.spent), available strata=$count." }
                }
            }
            Write-Reports
            if($Mode -eq 'RunOnce'){break}
            Start-Sleep -Seconds 30
        }
    } finally { if($lock){$lock.Dispose()} }
}

if($Library){return}
try {
    $config=Read-JsonFile $ConfigPath
    if($Mode -eq 'Validate') {
        $issues=@(Get-ConfigIssues $config)
        if($issues.Count){Write-Host 'Not ready (no measurements submitted):';$issues | ForEach-Object {Write-Host " - $_"};exit 2}
        Write-Host 'Configuration valid. No measurements submitted.';exit 0
    }
    if($Mode -ne 'CheckQuota') {
        $issues=@(Get-ConfigIssues $config)
        if($issues.Count){throw ('Configuration is not ready: '+($issues -join ' '))}
    }
    if($Mode -eq 'Preflight'){Test-Endpoints $config;exit 0}
    if($Mode -ne 'Report') {
        $secureToken=Read-Host 'Globalping API token (hidden; never saved)' -AsSecureString
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try{$script:AuthHeaders=@{Authorization=('Bearer '+[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer));'User-Agent'='BenchPoll-Globalping-Monitor/1.0'}}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secureToken.Dispose()}
    }
    if($Mode -eq 'CheckQuota') {
        $q=(Invoke-GpApi '/limits').data
        Write-Host ($q | ConvertTo-Json -Depth 8)
        if($q.rateLimit.measurements.create.type -ne 'user'){throw 'Token did not authenticate a member account.'}
        exit 0
    }
    Start-Monitor $config
} catch {
    # Only controlled errors are printed. Never dump request objects, headers or token-bearing exceptions.
    $message=$_.Exception.Message
    if($script:AuthHeaders -and $script:AuthHeaders.Authorization){$message=$message.Replace($script:AuthHeaders.Authorization,'[REDACTED]');$message=$message.Replace($script:AuthHeaders.Authorization.Substring(7),'[REDACTED]')}
    Write-Host "Stopped: $message" -ForegroundColor Red
    exit 1
} finally { $script:AuthHeaders=$null }
