param()

if (-not $env:NPM_TOKEN) {
    Write-Host "NPM_TOKEN not set. Falling back to interactive npm login..."
    npm login
} else {
    Write-Host "Using NPM_TOKEN from environment to set up auth"
    $npmrc = Join-Path $env:USERPROFILE ".npmrc"
    "//registry.npmjs.org/:_authToken=$env:NPM_TOKEN" | Out-File -FilePath $npmrc -Encoding ascii -Append
}

npm publish --access public

# cleanup if we injected token
if ($env:NPM_TOKEN) {
    Write-Host "Removing injected token from .npmrc"
    (Get-Content $npmrc) | Where-Object { $_ -notmatch "_authToken" } | Set-Content $npmrc
}
