#requires -Version 7.0
function Resolve-ClaudeLiveContract {
    param([Parameter(Mandatory)]$Job)

    $model = if ($Job.model) { [string]$Job.model } else { 'fable' }
    $effort = if ($Job.effort) { [string]$Job.effort } else { 'high' }
    if ($effort -notin @('low','medium','high','xhigh','max')) {
        throw 'Invalid effort.'
    }

    [pscustomobject]@{
        Model = $model
        Effort = $effort
    }
}
