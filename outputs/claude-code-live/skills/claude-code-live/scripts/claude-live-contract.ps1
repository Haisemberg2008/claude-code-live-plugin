#requires -Version 7.0
function Get-ClaudeLiveProperty {
    param($InputObject, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-ClaudeLiveResponsibilities {
    param([Parameter(Mandatory)]$Value)
    $stageNames = @('planning','inspection','implementation','testing','review','commit','push','deploy')
    $allowedActors = @('codex','claude','user','not_applicable')
    foreach ($providedStage in @($Value.PSObject.Properties.Name)) {
        if ($providedStage -notin $stageNames) {
            throw "coordination.responsibilities contains unexpected stage $providedStage."
        }
    }
    $normalized = [ordered]@{}
    foreach ($stage in $stageNames) {
        $actorValue = Get-ClaudeLiveProperty -InputObject $Value -Name $stage
        if ($null -eq $actorValue -or [string]::IsNullOrWhiteSpace([string]$actorValue)) {
            throw "coordination.responsibilities.$stage is required."
        }
        $actor = ([string]$actorValue).ToLowerInvariant()
        if ($actor -notin $allowedActors) {
            throw "coordination.responsibilities.$stage has an invalid actor."
        }
        if ($stage -in @('commit','push','deploy') -and $actor -eq 'claude') {
            throw "Claude cannot own the $stage responsibility."
        }
        $normalized[$stage] = $actor
    }
    return [pscustomobject]$normalized
}

function ConvertTo-ClaudeLiveCoordination {
    param([Parameter(Mandatory)]$Value)
    $phase = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'phase')
    if ($phase -notin @('planning','execution')) {
        throw 'coordination.phase must be planning or execution.'
    }
    $scopeId = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'scopeId')
    if ([string]::IsNullOrWhiteSpace($scopeId)) { throw 'coordination.scopeId is required.' }
    $revisionValue = Get-ClaudeLiveProperty -InputObject $Value -Name 'approvalRevision'
    if ($revisionValue -isnot [byte] -and $revisionValue -isnot [int16] -and $revisionValue -isnot [int32] -and $revisionValue -isnot [int64]) {
        throw 'coordination.approvalRevision must be a positive integer.'
    }
    $revision = [int64]$revisionValue
    if ($revision -lt 1) { throw 'coordination.approvalRevision must be a positive integer.' }
    $approvedValue = Get-ClaudeLiveProperty -InputObject $Value -Name 'planApproved'
    if ($approvedValue -isnot [bool]) { throw 'coordination.planApproved must be a boolean.' }
    $summary = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'planSummary')
    $responsibilityValue = Get-ClaudeLiveProperty -InputObject $Value -Name 'responsibilities'
    if ($null -eq $responsibilityValue) { throw 'coordination.responsibilities is required.' }
    $responsibilities = ConvertTo-ClaudeLiveResponsibilities -Value $responsibilityValue
    if ($phase -eq 'execution') {
        if (-not $approvedValue) { throw 'The execution plan must be explicitly approved.' }
        if ([string]::IsNullOrWhiteSpace($summary)) { throw 'coordination.planSummary is required for execution.' }
    }
    [pscustomobject][ordered]@{
        Phase = $phase
        ScopeId = $scopeId.Trim()
        ApprovalRevision = $revision
        PlanSummary = $summary.Trim()
        PlanApproved = [bool]$approvedValue
        Responsibilities = $responsibilities
    }
}

function ConvertTo-ClaudeLiveModelPolicy {
    param([Parameter(Mandatory)]$Value)
    $allowedFields = @('mode','primary','alternate','switchAtRemainingPercent')
    foreach ($field in @($Value.PSObject.Properties.Name)) {
        if ($field -notin $allowedFields) { throw "modelPolicy contains unexpected field $field." }
    }
    $mode = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'mode')
    $primary = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'primary')
    $alternate = [string](Get-ClaudeLiveProperty -InputObject $Value -Name 'alternate')
    if ($mode -ne 'quota-aware') { throw 'modelPolicy.mode must be quota-aware.' }
    if ($primary -ne 'fable' -or $alternate -ne 'opus') {
        throw 'modelPolicy.primary must be fable and modelPolicy.alternate must be opus.'
    }
    $thresholdValue = Get-ClaudeLiveProperty -InputObject $Value -Name 'switchAtRemainingPercent'
    if ($null -eq $thresholdValue) { $thresholdValue = 3 }
    if ($thresholdValue -isnot [byte] -and $thresholdValue -isnot [int16] -and $thresholdValue -isnot [int32] -and $thresholdValue -isnot [int64]) {
        throw 'modelPolicy.switchAtRemainingPercent must be an integer from 1 through 20.'
    }
    $threshold = [int]$thresholdValue
    if ($threshold -lt 1 -or $threshold -gt 20) {
        throw 'modelPolicy.switchAtRemainingPercent must be an integer from 1 through 20.'
    }
    [pscustomobject][ordered]@{
        Mode = $mode
        Primary = $primary
        Alternate = $alternate
        SwitchAtRemainingPercent = $threshold
    }
}

function Get-ClaudeLiveModelPolicyFingerprint {
    param($ModelPolicy)
    if ($null -eq $ModelPolicy) { return 'null' }
    $normalized = ConvertTo-ClaudeLiveModelPolicy -Value $ModelPolicy
    [pscustomobject][ordered]@{
        mode = $normalized.Mode
        primary = $normalized.Primary
        alternate = $normalized.Alternate
        switchAtRemainingPercent = $normalized.SwitchAtRemainingPercent
    } | ConvertTo-Json -Compress
}

function Get-ClaudeLiveCoordinationFingerprint {
    param([Parameter(Mandatory)]$Coordination)
    [pscustomobject][ordered]@{
        phase = [string](Get-ClaudeLiveProperty $Coordination 'phase')
        scopeId = [string](Get-ClaudeLiveProperty $Coordination 'scopeId')
        planSummary = [string](Get-ClaudeLiveProperty $Coordination 'planSummary')
        responsibilities = Get-ClaudeLiveProperty $Coordination 'responsibilities'
    } | ConvertTo-Json -Depth 5 -Compress
}

function Assert-ClaudeLiveResumeCoordination {
    param(
        [Parameter(Mandatory)]$Current,
        [Parameter(Mandatory)]$Prior,
        $CurrentModelPolicy = $null,
        $PriorModelPolicy = $null
    )
    $currentContract = ConvertTo-ClaudeLiveCoordination -Value $Current
    $priorContract = ConvertTo-ClaudeLiveCoordination -Value $Prior
    $currentRevision = $currentContract.ApprovalRevision
    $priorRevision = $priorContract.ApprovalRevision
    if ($currentRevision -lt $priorRevision) {
        throw 'A resumed job cannot use an older approval revision.'
    }
    $changed = (Get-ClaudeLiveCoordinationFingerprint $currentContract) -ne (Get-ClaudeLiveCoordinationFingerprint $priorContract)
    $changed = $changed -or ((Get-ClaudeLiveModelPolicyFingerprint $CurrentModelPolicy) -ne (Get-ClaudeLiveModelPolicyFingerprint $PriorModelPolicy))
    if ($changed -and $currentRevision -le $priorRevision) {
        throw 'A changed resumed plan, responsibility matrix, or model policy requires a newer approval revision.'
    }
}

function Get-ClaudeLiveToolConfiguration {
    param([Parameter(Mandatory)]$Contract)
    $rules = @($Contract.AllowedCommands | ForEach-Object { $_.Rule })
    $tools = switch ($Contract.Mode) {
        'chat' { @() }
        'read' { @('Read','Glob','Grep') }
        'verify' { @('Read','Glob','Grep'); if ($rules.Count) { 'Bash' } }
        'local' { @('Read','Glob','Grep','Write','Edit'); if ($rules.Count) { 'Bash' } }
    }
    $allowed = @($tools | Where-Object { $_ -ne 'Bash' }) + $rules
    [pscustomobject]@{ Tools = @($tools); Allowed = @($allowed) }
}

function Resolve-ClaudeLiveContract {
    param([Parameter(Mandatory)]$Job)

    $coordinationValue = Get-ClaudeLiveProperty -InputObject $Job -Name 'coordination'
    if ($null -eq $coordinationValue) { throw 'coordination is required for every job.' }
    $coordination = ConvertTo-ClaudeLiveCoordination -Value $coordinationValue
    $mode = [string](Get-ClaudeLiveProperty -InputObject $Job -Name 'mode')
    if ($mode -notin @('chat','read','verify','local')) {
        throw 'Mode must be chat, read, verify or local.'
    }
    if ($coordination.Phase -eq 'planning' -and $mode -notin @('chat','read')) {
        throw 'A planning job may use only chat or read mode.'
    }
    if ($mode -eq 'local' -and $coordination.Responsibilities.implementation -ne 'claude') {
        throw 'Local editing mode requires Claude to own the implementation responsibility.'
    }

    $modelValue = Get-ClaudeLiveProperty -InputObject $Job -Name 'model'
    $modelPolicyValue = Get-ClaudeLiveProperty -InputObject $Job -Name 'modelPolicy'
    if ($null -ne $modelValue -and $null -ne $modelPolicyValue) {
        throw 'Use either model or modelPolicy, never both.'
    }
    $modelPolicy = if ($null -ne $modelPolicyValue) { ConvertTo-ClaudeLiveModelPolicy -Value $modelPolicyValue } else { $null }
    $model = if ($null -ne $modelValue -and -not [string]::IsNullOrWhiteSpace([string]$modelValue)) {
        [string]$modelValue
    } elseif ($null -ne $modelPolicy) {
        $modelPolicy.Primary
    } else {
        'fable'
    }
    $effort = if ($Job.effort) { [string]$Job.effort } else { 'high' }
    if ($effort -notin @('low','medium','high','xhigh','max')) {
        throw 'Invalid effort.'
    }

    $profile = if ($Job.profile) { [string]$Job.profile } else { 'diagnostic' }
    if ($profile -notin @('diagnostic','restricted')) {
        throw 'Profile must be diagnostic or restricted.'
    }
    $codexThreadIdValue = Get-ClaudeLiveProperty -InputObject $Job -Name 'codexThreadId'
    $codexThreadId = if ($null -ne $codexThreadIdValue) { [string]$codexThreadIdValue } else { $null }
    if ($codexThreadId -and $codexThreadId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') {
        throw 'codexThreadId must contain only letters, numbers, underscores, or hyphens and be at most 128 characters.'
    }
    $commands = @()
    foreach ($commandValue in @($Job.allowedCommands | Where-Object { $null -ne $_ })) {
        if ($mode -notin @('verify','local')) {
            throw 'allowedCommands are available only in verify or local mode.'
        }
        $rule = [string](Get-ClaudeLiveProperty -InputObject $commandValue -Name 'rule')
        $responsibility = [string](Get-ClaudeLiveProperty -InputObject $commandValue -Name 'responsibility')
        if ([string]::IsNullOrWhiteSpace($rule) -or [string]::IsNullOrWhiteSpace($responsibility)) {
            throw 'Each allowed command requires rule and responsibility.'
        }
        if ($rule -notmatch '^Bash\([^*\r\n]+\)$' -or $rule -match '[:*]') {
            throw 'Only explicit Bash command rules without wildcards are allowed.'
        }
        if ($rule -match '(?i)(\bgit\b[^)\r\n]*\b(commit|push)\b|\bgh\s+pr\s+(create|merge)\b|\b(deploy|publish)\b)') {
            throw 'A critical external command cannot be delegated to Claude.'
        }
        $allowedStages = if ($mode -eq 'verify') { @('inspection','testing') } else { @('inspection','implementation','testing') }
        if ($responsibility -notin $allowedStages) {
            throw "The $responsibility responsibility cannot authorize a command in $mode mode."
        }
        if ($coordination.Responsibilities.$responsibility -ne 'claude') {
            throw "Claude must own the $responsibility responsibility before that command is allowed."
        }
        $commands += [pscustomobject][ordered]@{ Rule = $rule; Responsibility = $responsibility }
    }

    [pscustomobject]@{
        Model = $model
        ModelPolicy = $modelPolicy
        Effort = $effort
        Mode = $mode
        Profile = $profile
        CodexThreadId = $codexThreadId
        AllowedCommands = @($commands)
        Coordination = $coordination
    }
}
